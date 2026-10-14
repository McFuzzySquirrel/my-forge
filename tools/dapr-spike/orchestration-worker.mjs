import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DaprWorkflowClient,
  WorkflowRuntime,
  WorkflowRuntimeStatus,
} from "@dapr/dapr";
import { approvalWorkflow, stubActivity } from "./dist/workflow.js";
import { waitForHttpHealth } from "./dist/readiness.js";
import { registerOrchestrationWorkflows } from "./dapr-engine/orchestration/index.ts";
import {
  EXECUTE_TASK_ACTIVITY_NAME,
  RESUME_TASK_ACTIVITY_NAME,
} from "./dapr-engine/orchestration/workflow.ts";

const runtime = new WorkflowRuntime({ daprHost: "127.0.0.1", daprPort: "50001" });
runtime.registerWorkflowWithName("approvalWorkflow", approvalWorkflow);
runtime.registerActivityWithName("stubActivity", stubActivity);
runtime.registerWorkflowWithName("readinessWorkflow", async () => true);
registerOrchestrationWorkflows(runtime);
runtime.registerActivityWithName(EXECUTE_TASK_ACTIVITY_NAME, executeTask);
runtime.registerActivityWithName(RESUME_TASK_ACTIVITY_NAME, resumeTask);

let ready = false;
let startupAdmissionMs;
let latestAdmissionMs;
let admission;
let stopping = false;

async function record(input, type, outcome, controlId) {
  const entry = {
    at: new Date().toISOString(),
    type,
    runId: input.runId,
    taskId: input.taskId,
    logicalAttempt: input.logicalAttempt,
    operationId: input.operationId,
    ...(controlId ? { controlId } : {}),
    outcome,
  };
  await appendFile(`/artifacts/${input.runId}.jsonl`, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return outcome;
}

async function executeTask(_context, input) {
  if (input.taskId !== "T1" || !/^sha256:[0-9a-f]{64}$/.test(input.manifestDigest)) {
    throw new Error("Unexpected P4-01 integration task input");
  }
  const outcome = input.logicalAttempt === 1
    ? { status: "failed", retryable: true, failureCode: "integration-retry" }
    : { status: "waiting", waitId: "approval-1" };
  if (input.logicalAttempt > 2) throw new Error("Unexpected integration retry");
  return record(input, "execute", outcome);
}

async function resumeTask(_context, input) {
  if (input.waitId !== "approval-1"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.controlId)) {
    throw new Error("Invalid P4-01 integration wake event");
  }
  return record(input, "resume", { status: "complete" }, input.controlId);
}

async function proveAdmission() {
  const started = Date.now();
  const client = new DaprWorkflowClient({ daprHost: "127.0.0.1", daprPort: "50001" });
  const instanceId = `readiness-${randomUUID()}`;
  try {
    await client.scheduleNewWorkflow("readinessWorkflow", undefined, instanceId);
    const state = await client.waitForWorkflowCompletion(instanceId, true, 10);
    if (state?.runtimeStatus !== WorkflowRuntimeStatus.COMPLETED || state.serializedOutput !== "true") {
      throw new Error("Workflow poller did not complete the readiness probe");
    }
    await client.purgeWorkflow(instanceId);
    latestAdmissionMs = Date.now() - started;
    return true;
  } finally {
    await client.stop();
  }
}

const server = createServer(async (_request, response) => {
  let admitted = false;
  if (ready && !stopping) {
    try {
      admission ??= proveAdmission().finally(() => { admission = undefined; });
      admitted = await admission;
    } catch {
      admitted = false;
    }
  }
  response.writeHead(admitted ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready: admitted, startupAdmissionMs, latestAdmissionMs }));
});

server.listen(8083, "127.0.0.1");

async function stop() {
  if (stopping) return;
  stopping = true;
  ready = false;
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  try {
    await runtime.stop();
    server.close();
    clearTimeout(deadline);
    process.exitCode = 0;
  } catch (error) {
    console.error("Workflow worker shutdown failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
    server.close();
  }
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });

try {
  await waitForHttpHealth("http://127.0.0.1:3500/v1.0/healthz");
  await runtime.start();
  await proveAdmission();
  startupAdmissionMs = latestAdmissionMs;
  ready = true;
} catch (error) {
  console.error("Workflow worker startup failed:", error instanceof Error ? error.message : "unknown error");
  await stop();
  process.exitCode = 1;
}
