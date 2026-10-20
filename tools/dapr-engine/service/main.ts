import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DaprWorkflowClient, WorkflowRuntime, WorkflowRuntimeStatus } from "@dapr/dapr";
import { Pool } from "pg";
import { TaskApprovalCoordinator } from "../orchestration/approval-control.ts";
import { ExecutionHost } from "../orchestration/execution-host.ts";
import {
  APPLY_RUN_CONTROL_ACTIVITY_NAME,
  GET_RUN_CONTROL_ACTIVITY_NAME,
  LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  RunControlCoordinator,
  createApplyRunControlActivity,
  createGetRunControlActivity,
  createListAcceptedRunControlsActivity,
  registerOrchestrationWorkflows,
} from "../orchestration/index.ts";
import { createRecordRunLifecycleEventActivity } from "../orchestration/status-activity.ts";
import { RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME } from "../orchestration/workflow.ts";
import { FileArtifactCheckpointStore } from "../storage/files/artifact-checkpoint-store.ts";
import {
  PostgresControlRecordStore,
  PostgresExecutionOwnershipStore,
  PostgresOperationReceiptStore,
  PostgresRepositoryIntegrationAuthority,
  PostgresRunStatusStore,
  PostgresRunSubmissionStore,
} from "../storage/index.ts";
import { createServiceApiHandler, MIN_API_TOKEN_LENGTH } from "./api.ts";
import { migrateApplicationDatabase } from "./migrations.ts";
import {
  RunService,
  ServiceRunRegistry,
  createServiceRunControlEffects,
  defaultServiceHarnesses,
  leaseReleasingLifecycleWriter,
  mountedRepositoryResolver,
} from "./runs.ts";

const PORT = Number(process.env.MYFORGE_SERVICE_PORT ?? "8083");
const DAPR_HOST = process.env.DAPR_HOST ?? "daprd";
const DAPR_GRPC_PORT = process.env.DAPR_GRPC_PORT ?? "50001";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT ?? "3500";
const DATABASE_URL = process.env.MYFORGE_DATABASE_URL;
const DATA_DIR = process.env.MYFORGE_RUNTIME_DATA_DIR ?? "/var/lib/myforge";
const REPOSITORIES_DIR = process.env.MYFORGE_REPOSITORIES_DIR ?? "/repositories";
const API_TOKEN = process.env.MYFORGE_API_TOKEN ?? "";
const READY_TIMEOUT_MS = 120_000;
const HEARTBEAT_TTL_MS = 30_000;

if (!DATABASE_URL) throw new Error("MYFORGE_DATABASE_URL is required");
if (API_TOKEN.length < MIN_API_TOKEN_LENGTH) {
  throw new Error(`MYFORGE_API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters`);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("MYFORGE_SERVICE_PORT must be between 1 and 65535");
}

const database = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  max: 10,
});
const daprAddress = { daprHost: DAPR_HOST, daprPort: DAPR_GRPC_PORT };
const daprHttpUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}`;
const runtime = new WorkflowRuntime(daprAddress);
const client = new DaprWorkflowClient(daprAddress);
const repositoryRoot = mountedRepositoryResolver(REPOSITORIES_DIR);
const registry = new ServiceRunRegistry(defaultServiceHarnesses());
const status = new PostgresRunStatusStore(database);
const controls = new PostgresControlRecordStore(database);
const executions = new PostgresExecutionOwnershipStore(database);
const submissions = new PostgresRunSubmissionStore(database);
let server: Server | undefined;
let sweeper: NodeJS.Timeout | undefined;
let ready = false;
let stopping = false;
let stoppingPromise: Promise<void> | undefined;

async function waitForDapr(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${daprHttpUrl}/v1.0/healthz/outbound`, {
        headers: { "dapr-api-token": process.env.DAPR_API_TOKEN ?? "" },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The sidecar may start after the worker container.
    }
    await delay(500);
  }
  throw new Error("Dapr sidecar did not become ready before the startup deadline");
}

async function proveWorkflowAdmission(): Promise<void> {
  const instanceId = `readiness-${randomUUID()}`;
  try {
    process.stdout.write(`Scheduling Dapr workflow admission probe ${instanceId}\n`);
    await client.scheduleNewWorkflow("myforgeReadinessWorkflow", undefined, instanceId);
    process.stdout.write("Dapr workflow admission probe scheduled\n");
    const state = await client.waitForWorkflowCompletion(instanceId, true, 10);
    if (state?.runtimeStatus !== WorkflowRuntimeStatus.COMPLETED || state.serializedOutput !== "true") {
      throw new Error("Workflow worker did not complete its readiness probe");
    }
    await client.purgeWorkflow(instanceId);
  } catch (error) {
    await client.purgeWorkflow(instanceId).catch(() => undefined);
    throw error;
  }
}

const checkpoints = new FileArtifactCheckpointStore(join(DATA_DIR, "artifacts"));
const integration = new PostgresRepositoryIntegrationAuthority(database, repositoryRoot, checkpoints);

function createWorkflowHost(): ExecutionHost {
  const receipts = new PostgresOperationReceiptStore(database);
  return new ExecutionHost({
    runs: (runId) => registry.get(runId),
    receipts,
    executions,
    integration,
    checkpoints,
    status,
    controls,
    repositoryRoot,
    scratchRoot: join(DATA_DIR, "scratch"),
    workerId: process.env.MYFORGE_WORKER_ID ?? `local-${randomUUID()}`,
    budgetMs: 15 * 60_000,
    heartbeatIntervalMs: 2_000,
    heartbeatTtlMs: HEARTBEAT_TTL_MS,
    audit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
}

const workflowEvents = {
  raiseEvent: (instanceId: string, name: string, payload: unknown) => client.raiseEvent(instanceId, name, payload),
};

async function scheduleRun(instanceId: string, input: unknown): Promise<void> {
  if (await client.getWorkflowState(instanceId, false)) return;
  try {
    await client.scheduleNewWorkflow(RUN_ORCHESTRATION_WORKFLOW_NAME, input, instanceId);
  } catch (error) {
    // A concurrent duplicate submission may have scheduled the same instance.
    if (!await client.getWorkflowState(instanceId, false)) throw error;
  }
}

function createRunService(host: ExecutionHost): RunService {
  return new RunService({
    submissions,
    status,
    registry,
    repositoryRoot,
    scheduleRun,
    runControls: new RunControlCoordinator(controls, {
      async getRunControlContext(runId) {
        const run = await status.getRunStatus(runId);
        return run && {
          runId,
          status: run.status,
          taskStatuses: Object.fromEntries(run.tasks.map((task) => [task.taskId, task.status])),
        };
      },
    }, workflowEvents),
    approvals: new TaskApprovalCoordinator(controls, workflowEvents),
    approvalContext: (runId, taskId) => host.approvalContext(runId, taskId),
  });
}

function registerRunControlActivities(): void {
  const effects = createServiceRunControlEffects({ executions, replays: submissions });
  runtime
    .registerActivityWithName(GET_RUN_CONTROL_ACTIVITY_NAME, createGetRunControlActivity(controls))
    .registerActivityWithName(LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME, createListAcceptedRunControlsActivity(controls))
    .registerActivityWithName(APPLY_RUN_CONTROL_ACTIVITY_NAME, createApplyRunControlActivity(controls, effects));
}

async function listen(runs: RunService): Promise<void> {
  server = createServer(createServiceApiHandler({
    token: API_TOKEN,
    runs,
    health: () => ({ live: !stopping, ready: ready && !stopping }),
    onError: (error) => process.stderr.write(`API request failed: ${error instanceof Error ? error.message : "unknown error"}\n`),
  }));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(PORT, "0.0.0.0", resolve);
  });
}

async function closeServer(): Promise<void> {
  const current = server;
  if (!current || !current.listening) {
    server = undefined;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    current.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
}

async function stop(): Promise<void> {
  if (stoppingPromise) return stoppingPromise;
  stopping = true;
  ready = false;
  stoppingPromise = (async () => {
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    try {
      if (sweeper) clearInterval(sweeper);
      await closeServer();
      await runtime.stop();
      await client.stop();
    } catch (error) {
      process.stderr.write(`Execution service shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    } finally {
      await database.end();
      clearTimeout(deadline);
    }
  })();
  return stoppingPromise;
}

async function start(): Promise<void> {
  process.stdout.write("Execution service starting\n");
  await mkdir(join(DATA_DIR, "artifacts"), { recursive: true, mode: 0o700 });
  await mkdir(join(DATA_DIR, "scratch"), { recursive: true, mode: 0o700 });
  const host = createWorkflowHost();
  const runs = createRunService(host);
  await listen(runs);
  await database.query("SELECT 1");
  await migrateApplicationDatabase(database);
  process.stdout.write("Application database migrations are current\n");
  runtime.registerWorkflowWithName("myforgeReadinessWorkflow", async () => true);
  registerOrchestrationWorkflows(runtime);
  runtime.registerActivityWithName(
    RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME,
    createRecordRunLifecycleEventActivity(leaseReleasingLifecycleWriter(
      status,
      (runId) => integration.releaseRun(runId),
      (runId, error) => process.stderr.write(
        `Repository leases for ${runId} were not released: ${error instanceof Error ? error.message : "unknown error"}\n`,
      ),
    )),
  );
  host.register(runtime);
  registerRunControlActivities();
  const reportUnbound = (runId: string, error: unknown) => {
    process.stderr.write(`Run ${runId} could not be rebound: ${error instanceof Error ? error.message : "unknown error"}\n`);
  };
  process.stdout.write(`Bound ${await runs.bindStored(reportUnbound)} stored run(s)\n`);
  await waitForDapr();
  process.stdout.write("Dapr sidecar is ready\n");
  await runtime.start();
  process.stdout.write("Dapr workflow worker is running\n");
  await proveWorkflowAdmission();
  await runs.recover(reportUnbound);
  sweeper = setInterval(() => {
    executions.fenceLostExecutions().catch((error: unknown) => {
      process.stderr.write(`Lost-execution sweep failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    });
  }, HEARTBEAT_TTL_MS);
  sweeper.unref();
  ready = true;
  process.stdout.write("Execution service is ready\n");
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });

try {
  await start();
} catch (error) {
  process.stderr.write(`Execution service startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  await stop();
  process.exitCode = 1;
}
