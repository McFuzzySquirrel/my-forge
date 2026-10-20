import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DaprWorkflowClient, WorkflowRuntime, WorkflowRuntimeStatus } from "@dapr/dapr";
import { Pool } from "pg";
import { ExecutionHost } from "../orchestration/execution-host.ts";
import { registerOrchestrationWorkflows } from "../orchestration/index.ts";
import { registerRunLifecycleEventActivity } from "../orchestration/status-activity.ts";
import { FileArtifactCheckpointStore } from "../storage/files/artifact-checkpoint-store.ts";
import {
  PostgresControlRecordStore,
  PostgresExecutionOwnershipStore,
  PostgresOperationReceiptStore,
  PostgresRepositoryIntegrationAuthority,
  PostgresRunStatusStore,
} from "../storage/index.ts";
import { migrateApplicationDatabase } from "./migrations.ts";

const PORT = Number(process.env.MYFORGE_SERVICE_PORT ?? "8083");
const DAPR_HOST = process.env.DAPR_HOST ?? "daprd";
const DAPR_GRPC_PORT = process.env.DAPR_GRPC_PORT ?? "50001";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT ?? "3500";
const DATABASE_URL = process.env.MYFORGE_DATABASE_URL;
const DATA_DIR = process.env.MYFORGE_RUNTIME_DATA_DIR ?? "/var/lib/myforge";
const READY_TIMEOUT_MS = 120_000;

if (!DATABASE_URL) throw new Error("MYFORGE_DATABASE_URL is required");
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
let server: Server | undefined;
let ready = false;
let stopping = false;
let stoppingPromise: Promise<void> | undefined;

function sendHealth(response: import("node:http").ServerResponse, ok: boolean): void {
  response.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ready: ok }));
}

async function waitForDapr(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${daprHttpUrl}/v1.0/healthz/outbound`, {
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

function createWorkflowHost(): ExecutionHost {
  const checkpoints = new FileArtifactCheckpointStore(join(DATA_DIR, "artifacts"));
  const status = new PostgresRunStatusStore(database);
  const controls = new PostgresControlRecordStore(database);
  const receipts = new PostgresOperationReceiptStore(database);
  const executions = new PostgresExecutionOwnershipStore(database);
  const integration = new PostgresRepositoryIntegrationAuthority(
    database,
    () => undefined,
    checkpoints,
  );
  return new ExecutionHost({
    runs: () => undefined,
    receipts,
    executions,
    integration,
    checkpoints,
    status,
    controls,
    repositoryRoot: () => undefined,
    scratchRoot: join(DATA_DIR, "scratch"),
    workerId: process.env.MYFORGE_WORKER_ID ?? `local-${randomUUID()}`,
    budgetMs: 15 * 60_000,
    heartbeatIntervalMs: 2_000,
    heartbeatTtlMs: 30_000,
    audit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
}

async function listen(): Promise<void> {
  server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
    } else if (request.url === "/health/live") {
      sendHealth(response, !stopping);
    } else if (request.url === "/health/ready") {
      sendHealth(response, ready && !stopping);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
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
  await listen();
  await database.query("SELECT 1");
  await migrateApplicationDatabase(database);
  process.stdout.write("Application database migrations are current\n");
  runtime.registerWorkflowWithName("myforgeReadinessWorkflow", async () => true);
  registerOrchestrationWorkflows(runtime);
  registerRunLifecycleEventActivity(runtime, database);
  createWorkflowHost().register(runtime);
  await waitForDapr();
  process.stdout.write("Dapr sidecar is ready\n");
  await runtime.start();
  process.stdout.write("Dapr workflow worker is running\n");
  await proveWorkflowAdmission();
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
