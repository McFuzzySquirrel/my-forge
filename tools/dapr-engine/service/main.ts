import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
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
  assertActiveRunDefinitionsSupported,
  registerOrchestrationWorkflows,
  runOrchestrationWorkflowId,
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
import { secureRegisteredGitMetadata } from "./repository-git-boundary.ts";
import { PostgresHostRunnerJobStore } from "../storage/postgres/host-runner-jobs.ts";
import { HostRunnerService, loadHostRunnerCapabilityHashes } from "./host-runner.ts";
import { HostRunnerMonitor } from "./host-runner-monitor.ts";
import { QueuedHarnessRunner } from "../execution/queued-harness-runner.ts";
import { reconcileFailedRuns, type OrchestrationFailureV1 } from "./run-reconciler.ts";
import { sdkWorkflowWorkerProbe, watchWorkflowWorker } from "./worker-watchdog.ts";
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
const TASK_SCRATCH_DIR = join(tmpdir(), "myforge-task-scratch");
const API_TOKEN = process.env.MYFORGE_API_TOKEN ?? "";
const READY_TIMEOUT_MS = 120_000;
const HEARTBEAT_TTL_MS = 30_000;
const RUN_RECONCILE_INTERVAL_MS = 60_000;
const WORKER_LOSS_RECOVERY_TIMEOUT_MS = 600_000;

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
const hostRunnerJobs = new PostgresHostRunnerJobStore(database);
const hostRunnerCapabilityHashes = await loadHostRunnerCapabilityHashes(
  process.env.MYFORGE_HOST_RUNNER_CAPABILITY_HASHES_FILE,
);
const hostRunner = new HostRunnerService({ jobs: hostRunnerJobs, capabilityHashes: hostRunnerCapabilityHashes });
const hostRunnerMonitor = new HostRunnerMonitor(hostRunnerJobs);
const queuedHarnessRunner = new QueuedHarnessRunner(hostRunnerJobs);
// A PostgreSQL restart must not crash the service: the pool discards broken
// idle clients, and a checked-out client fails its next query instead.
database.on("error", (error) => {
  process.stderr.write(`PostgreSQL connection lost: ${error.message}\n`);
});
database.on("connect", (connection) => {
  connection.on("error", () => {});
});
const daprAddress = { daprHost: DAPR_HOST, daprPort: DAPR_GRPC_PORT };
const daprHttpUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}`;
const runtime = new WorkflowRuntime(daprAddress);
const client = new DaprWorkflowClient(daprAddress);
const repositoryRoot = mountedRepositoryResolver(REPOSITORIES_DIR);
const registry = new ServiceRunRegistry(defaultServiceHarnesses({
  credentialsFile: process.env.MYFORGE_HARNESS_CREDENTIALS_FILE,
}), {
  runner: queuedHarnessRunner,
  enabledForRepository: (repositoryId) => hostRunnerCapabilityHashes.has(repositoryId),
});
const status = new PostgresRunStatusStore(database);
const controls = new PostgresControlRecordStore(database);
const executions = new PostgresExecutionOwnershipStore(database);
const submissions = new PostgresRunSubmissionStore(database);
let server: Server | undefined;
let sweeper: NodeJS.Timeout | undefined;
let reconciler: NodeJS.Timeout | undefined;
let ready = false;
let stopping = false;
let stoppingPromise: Promise<void> | undefined;

async function waitForDapr(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

async function waitForDatabase(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await database.query("SELECT 1");
      return;
    } catch {
      await delay(1_000);
    }
  }
  throw new Error("The application database did not recover before the deadline");
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
    taskUidIsolation: true,
    taskScratchRoot: TASK_SCRATCH_DIR,
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

const lifecycleWriter = leaseReleasingLifecycleWriter(
  status,
  (runId) => integration.releaseRun(runId),
  (runId, error) => process.stderr.write(
    `Repository leases for ${runId} were not released: ${error instanceof Error ? error.message : "unknown error"}\n`,
  ),
);

async function orchestrationFailure(runId: string): Promise<OrchestrationFailureV1 | undefined> {
  const instanceId = runOrchestrationWorkflowId(runId);
  const state = await client.getWorkflowState(instanceId, false);
  if (state?.runtimeStatus === WorkflowRuntimeStatus.FAILED) {
    // Failure details are only returned with the payloads.
    const detailed = await client.getWorkflowState(instanceId, true).catch(() => undefined);
    return { runtimeStatus: "FAILED", message: detailed?.workflowFailureDetails?.getErrorMessage() };
  }
  if (state?.runtimeStatus === WorkflowRuntimeStatus.TERMINATED) return { runtimeStatus: "TERMINATED" };
  return undefined;
}

let reconciling = false;
async function reconcileRuns(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const reconciled = await reconcileFailedRuns(
      { listActiveRunIds: () => status.listActiveRunIds(), orchestrationFailure, appendEvent: (input) => lifecycleWriter.appendEvent(input) },
      (runId, error) => process.stderr.write(
        `Run ${runId} could not be reconciled: ${error instanceof Error ? error.message : "unknown error"}\n`,
      ),
    );
    if (reconciled > 0) process.stderr.write(`Marked ${reconciled} run(s) failed after their orchestration failed\n`);
  } catch (error) {
    process.stderr.write(`Run reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  } finally {
    reconciling = false;
  }
}

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
    hostRunner,
    hostRunnerMonitor,
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
      if (reconciler) clearInterval(reconciler);
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
  await rm(TASK_SCRATCH_DIR, { recursive: true, force: true });
  await mkdir(TASK_SCRATCH_DIR, { recursive: true, mode: 0o711 });
  await secureRegisteredGitMetadata(REPOSITORIES_DIR);
  const host = createWorkflowHost();
  const runs = createRunService(host);
  await listen(runs);
  await database.query("SELECT 1");
  await migrateApplicationDatabase(database);
  process.stdout.write("Application database migrations are current\n");
  await assertActiveRunDefinitionsSupported(database);
  runtime.registerWorkflowWithName("myforgeReadinessWorkflow", async () => true);
  registerOrchestrationWorkflows(runtime);
  runtime.registerActivityWithName(
    RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME,
    createRecordRunLifecycleEventActivity(lifecycleWriter),
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
  const workerProbe = sdkWorkflowWorkerProbe(runtime);
  if (workerProbe.running() === undefined) {
    process.stderr.write("Dapr workflow worker state is not observable with this SDK; sidecar-loss recovery is disabled\n");
  }
  watchWorkflowWorker({
    probe: workerProbe,
    stopping: () => stopping,
    onLost: () => {
      process.stderr.write("Dapr workflow worker stopped after losing the sidecar connection; restarting the service once its dependencies are back\n");
      ready = false;
      process.exitCode = 1;
      // Podman skips the restart policy while a required container is down,
      // so exit only after the sidecar and database are reachable again.
      void (async () => {
        await waitForDapr(WORKER_LOSS_RECOVERY_TIMEOUT_MS)
          .then(() => waitForDatabase(WORKER_LOSS_RECOVERY_TIMEOUT_MS))
          .catch((error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.message : "Dependencies did not recover"}; exiting anyway\n`);
          });
        await stop();
      })().finally(() => process.exit(1));
    },
  });
  await proveWorkflowAdmission();
  await runs.recover(reportUnbound);
  sweeper = setInterval(() => {
    executions.fenceLostExecutions().catch((error: unknown) => {
      process.stderr.write(`Lost-execution sweep failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    });
  }, HEARTBEAT_TTL_MS);
  sweeper.unref();
  await reconcileRuns();
  reconciler = setInterval(() => { void reconcileRuns(); }, RUN_RECONCILE_INTERVAL_MS);
  reconciler.unref();
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
