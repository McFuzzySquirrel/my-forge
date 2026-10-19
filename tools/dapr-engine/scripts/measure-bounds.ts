/**
 * P4-06 live bound measurement: large manifests, history rollover, retry storms,
 * long approval waits across a worker restart, control delivery across frequent
 * continue-as-new, run admission, and outcome/payload bounds. Task activities are
 * stubs so the measurement isolates Dapr history and scheduling behavior.
 *
 *   npm run measure:bounds -- [--evidence path] [--wait-seconds 60] [--tasks 240] [--only scenario]
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DaprWorkflowClient, WorkflowRuntime } from "@dapr/dapr";
import { canonicalDigest, type ControlRequestV1 } from "../contract/v1/index.ts";
import {
  boundTaskExecutionOutcome,
  buildOrchestrationPlan,
  createTaskCompletionEvidence,
  DAPR_SDK_WORKER_LIMITS,
  MAX_FAILURE_REASON_CHARS,
  MAX_WORKER_TASK_ATTEMPTS,
  createApplyRunControlActivity,
  createGetRunControlActivity,
  createListAcceptedRunControlsActivity,
  registerOrchestrationWorkflows,
  RunAdmissionController,
  RUN_LIMITS_V1,
  type ApprovalControlStore,
  type ExecuteTaskActivityInputV1,
  type ResumeTaskActivityInputV1,
  type TaskActivityOutcomeV1,
} from "../orchestration/index.ts";
import {
  APPLY_RUN_CONTROL_ACTIVITY_NAME,
  EXECUTE_TASK_ACTIVITY_NAME,
  GET_RUN_CONTROL_ACTIVITY_NAME,
  LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME,
  RESUME_TASK_ACTIVITY_NAME,
  RUN_CONTROL_EVENT_NAME,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  runOrchestrationWorkflowId,
  TASK_CONTROL_EVENT_NAME,
  taskAttemptWorkflowIdForAttempt,
  taskOperationId,
  type RunWorkflowInputV1,
} from "../orchestration/workflow.ts";
import type { ControlStoreResult, StoredControlRecordV1 } from "../storage/postgres/control-records.ts";
import { acceptedSubmission, manifestTask } from "../tests/support/execution-fixture.ts";
import { IMAGES, podman, quietDurableTaskInfo, startDapr, waitFor, type DaprStack } from "./support/dapr-stack.ts";

const SHA256 = `sha256:${"0".repeat(64)}` as const;

interface Options {
  readonly evidence: string;
  readonly waitSeconds: number;
  readonly tasks: number;
  readonly only?: string;
}

function parseOptions(argv: readonly string[]): Options {
  let evidence = resolve(".runtime/p4-06-bounds.json");
  let waitSeconds = 60;
  let tasks = 240;
  let only: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--evidence" && value) { evidence = resolve(value); index += 1; }
    else if (arg === "--wait-seconds" && value) { waitSeconds = Number(value); index += 1; }
    else if (arg === "--tasks" && value) { tasks = Number(value); index += 1; }
    else if (arg === "--only" && value) { only = value; index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 10) throw new Error("--wait-seconds must be an integer >= 10");
  if (!Number.isSafeInteger(tasks) || tasks < 16 || tasks > RUN_LIMITS_V1.maxTasksPerRun) {
    throw new Error(`--tasks must be an integer from 16 to ${RUN_LIMITS_V1.maxTasksPerRun}`);
  }
  return { evidence, waitSeconds, tasks, ...(only ? { only } : {}) };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** In-memory durable control store with the PostgreSQL store's transition rules. */
class MemoryControlStore implements ApprovalControlStore {
  readonly records = new Map<string, StoredControlRecordV1>();

  async request(request: ControlRequestV1): Promise<ControlStoreResult> {
    const prior = this.records.get(request.controlId);
    if (prior) return { ok: true, record: structuredClone(prior), reused: true };
    const record: StoredControlRecordV1 = {
      ...request,
      requestDigest: canonicalDigest({ runId: request.runId, action: request.action, payload: request.payload }),
      state: "requested",
      history: ["requested"],
      recordVersion: 1,
      payload: request.payload,
    };
    this.records.set(request.controlId, record);
    return { ok: true, record: structuredClone(record), reused: false };
  }

  async get(controlId: string): Promise<StoredControlRecordV1 | undefined> {
    const record = this.records.get(controlId);
    return record ? structuredClone(record) : undefined;
  }

  async listAccepted(runId: string, limit: number): Promise<readonly StoredControlRecordV1[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId && record.state === "accepted" && record.action !== "approve-task")
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async transition(
    controlId: string,
    expectedRecordVersion: number,
    to: "accepted" | "applied" | "rejected",
  ): Promise<ControlStoreResult> {
    const record = this.records.get(controlId);
    if (!record) return { ok: false, code: "unknown-control" };
    if (record.recordVersion !== expectedRecordVersion) return { ok: false, code: "stale-revision" };
    const allowed = (record.state === "requested" && (to === "accepted" || to === "rejected"))
      || (record.state === "accepted" && (to === "applied" || to === "rejected"));
    if (!allowed) return { ok: false, code: "invalid-transition" };
    const next: StoredControlRecordV1 = {
      ...record,
      state: to,
      history: [...record.history, to],
      recordVersion: record.recordVersion + 1,
    };
    this.records.set(controlId, next);
    return { ok: true, record: structuredClone(next), reused: false };
  }
}

type Behavior = (input: ExecuteTaskActivityInputV1) => TaskActivityOutcomeV1;

interface RunProbe {
  readonly behavior: Behavior;
  readonly delayMs: number;
  readonly operations: Array<{ taskId: string; logicalAttempt: number; operationId: string }>;
  active: number;
  peak: number;
  generations: number;
}

/** Process-wide stub worker state shared across worker restarts. */
class Harness {
  readonly controls = new MemoryControlStore();
  readonly probes = new Map<string, RunProbe>();
  readonly replayAttempts = new Map<string, number>();
  globalActive = 0;
  globalPeak = 0;

  probe(runId: string): RunProbe {
    const probe = this.probes.get(runId);
    if (!probe) throw new Error(`No probe for ${runId}`);
    return probe;
  }

  register(runtime: WorkflowRuntime): WorkflowRuntime {
    registerOrchestrationWorkflows(runtime);
    runtime.registerActivityWithName(EXECUTE_TASK_ACTIVITY_NAME, async (_context: unknown, input: ExecuteTaskActivityInputV1) => {
      const probe = this.probe(input.runId);
      probe.operations.push({ taskId: input.taskId, logicalAttempt: input.logicalAttempt, operationId: input.operationId });
      probe.active += 1;
      this.globalActive += 1;
      probe.peak = Math.max(probe.peak, probe.active);
      this.globalPeak = Math.max(this.globalPeak, this.globalActive);
      try {
        await sleep(probe.delayMs);
        return probe.behavior(input);
      } finally {
        probe.active -= 1;
        this.globalActive -= 1;
      }
    });
    // Approval binding is P4-04 scope; this stub resumes any wake so the measurement isolates history.
    runtime.registerActivityWithName(RESUME_TASK_ACTIVITY_NAME, async (_context: unknown, input: ResumeTaskActivityInputV1) =>
      complete(input));
    const store: Pick<ApprovalControlStore, "get" | "listAccepted" | "transition"> = {
      get: (controlId) => this.controls.get(controlId),
      transition: (controlId, version, to) => this.controls.transition(controlId, version, to),
      listAccepted: async (runId, limit) => {
        const probe = this.probes.get(runId);
        if (probe) probe.generations += 1;
        return this.controls.listAccepted(runId, limit);
      },
    };
    runtime
      .registerActivityWithName(GET_RUN_CONTROL_ACTIVITY_NAME, createGetRunControlActivity(store))
      .registerActivityWithName(LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME, createListAcceptedRunControlsActivity(store))
      .registerActivityWithName(APPLY_RUN_CONTROL_ACTIVITY_NAME, createApplyRunControlActivity(store, {
        pauseOrStop: async () => undefined,
        resume: async () => undefined,
        cancel: async () => undefined,
        replayTask: async (record) => {
          const taskId = String(record.payload.taskId);
          const prior = this.replayAttempts.get(record.controlId);
          if (prior) return prior;
          const next = Math.max(1, ...this.probe(record.runId).operations
            .filter((operation) => operation.taskId === taskId).map((operation) => operation.logicalAttempt)) + 1;
          this.replayAttempts.set(record.controlId, next);
          return next;
        },
      }));
    return runtime;
  }
}

/** Evidence binds the activity's own operation ID (the resume operation for a woken wait). */
function complete(input: ExecuteTaskActivityInputV1): TaskActivityOutcomeV1 {
  return {
    status: "complete",
    evidence: createTaskCompletionEvidence({
      runId: input.runId,
      taskId: input.taskId,
      manifestDigest: input.manifestDigest as `sha256:${string}`,
      logicalAttempt: input.logicalAttempt,
      operationId: input.operationId,
      outputFiles: [],
      handoffDigest: SHA256,
      artifactRefs: [],
      validationCommands: [],
    }),
  };
}

const completeAll: Behavior = (input) => complete(input);

/** Reads Dapr workflow history straight from the actor state store inside the pod. */
class HistoryMeter {
  private constructor(private readonly pod: string, private readonly table: string, private readonly valueExpr: string) {}

  static async create(pod: string): Promise<HistoryMeter> {
    const rows = await HistoryMeter.psql(pod, `SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'value' AND table_name IN (
        SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'key')`);
    const first = rows.split("\n").find(Boolean);
    if (!first) throw new Error("Dapr state table not found");
    const [table, type] = first.split("|") as [string, string];
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Unexpected Dapr state table name");
    return new HistoryMeter(pod, table, type === "bytea" ? "octet_length(value)" : "octet_length(value::text)");
  }

  private static psql(pod: string, sql: string): Promise<string> {
    return podman(["exec", `${pod}-postgres`, "psql", "-U", "dapr", "-d", "dapr", "-At", "-c", sql]);
  }

  /** History rows and bytes per instance; IDs are generated UUID-derived names, never user input. */
  async stats(instanceIds: readonly string[]): Promise<Record<string, { rows: number; bytes: number }>> {
    if (instanceIds.length === 0) return {};
    for (const id of instanceIds) if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Unsafe instance id");
    const values = instanceIds.map((id) => `('${id}')`).join(",");
    const output = await HistoryMeter.psql(this.pod, `SELECT v.id, count(s.key), coalesce(sum(${this.valueExpr.replace("value", "s.value")}), 0)
      FROM (VALUES ${values}) AS v(id) LEFT JOIN ${this.table} s ON s.key LIKE '%||' || v.id || '||history-%'
      GROUP BY v.id`);
    const result: Record<string, { rows: number; bytes: number }> = {};
    for (const line of output.split("\n").filter(Boolean)) {
      const [id, rows, bytes] = line.split("|") as [string, string, string];
      result[id] = { rows: Number(rows), bytes: Number(bytes) };
    }
    return result;
  }

  /** Samples peak history size for instances until stopped. */
  sample(instanceIds: () => readonly string[], intervalMs = 750): { stop: () => Promise<Record<string, { rows: number; bytes: number }>> } {
    const peaks: Record<string, { rows: number; bytes: number }> = {};
    let running = true;
    const loop = (async () => {
      while (running) {
        const stats = await this.stats(instanceIds()).catch(() => ({}));
        for (const [id, value] of Object.entries(stats)) {
          const peak = peaks[id] ?? { rows: 0, bytes: 0 };
          peaks[id] = { rows: Math.max(peak.rows, value.rows), bytes: Math.max(peak.bytes, value.bytes) };
        }
        await sleep(intervalMs);
      }
    })();
    return {
      stop: async () => {
        running = false;
        await loop;
        return peaks;
      },
    };
  }
}

interface Context {
  readonly harness: Harness;
  readonly client: DaprWorkflowClient;
  readonly meter: HistoryMeter;
  readonly restartWorker: () => Promise<void>;
  /** daprd HTTP port; the gRPC GetInstance in Dapr 1.18 omits custom status. */
  readonly httpPort: number;
  readonly options: Options;
}

function submissionFor(taskCount: number, settings: Record<string, number | boolean>, prefix = "t") {
  return acceptedSubmission({
    repositoryId: "p4-06-measure",
    phases: [{
      id: "phase-1",
      tasks: Array.from({ length: taskCount }, (_, index) =>
        // The planner serializes tasks that share an owner; spread owners so concurrency applies.
        manifestTask({ id: `${prefix}-${String(index + 1).padStart(4, "0")}`, ownerAgent: `measure-${index % 8}` })),
    }],
    settings: { concurrency: 8, maxRetries: 0, retryDelayMs: 1_000, ...settings },
  });
}

async function startRun(
  context: Context,
  taskCount: number,
  settings: Record<string, number | boolean>,
  behavior: Behavior,
  delayMs: number,
  runId = `run_${randomUUID().replaceAll("-", "")}`,
): Promise<{ runId: string; instanceId: string; submission: ReturnType<typeof submissionFor> }> {
  const submission = submissionFor(taskCount, settings);
  context.harness.probes.set(runId, { behavior, delayMs, operations: [], active: 0, peak: 0, generations: 1 });
  const instanceId = runOrchestrationWorkflowId(runId);
  const input: RunWorkflowInputV1 = { runId, submission, controlsEnabled: true, statusEnabled: false };
  await context.client.scheduleNewWorkflow(RUN_ORCHESTRATION_WORKFLOW_NAME, input, instanceId);
  return { runId, instanceId, submission };
}

/**
 * A controls-enabled run never completes as a workflow: it parks at a terminal control wait
 * (custom status complete/failed) so replay-task can reopen it. Wait for that, then terminate.
 */
async function finish(context: Context, instanceId: string, timeoutSeconds: number): Promise<{ status: string }> {
  let status = "";
  let ended: string | undefined;
  let lastError: unknown;
  await waitFor(async () => {
    const state = await workflowStatus(context, instanceId).catch((error: unknown) => {
      lastError = error;
      throw error;
    });
    if (state.runtimeStatus !== "RUNNING" && state.runtimeStatus !== "PENDING") {
      ended = `${state.runtimeStatus}: ${state.failure ?? ""}`;
      return true;
    }
    const custom = parseCustomStatus(state.customStatus);
    if (custom === "complete" || custom === "failed" || custom === "cancelled") status = custom;
    return status !== "";
  }, timeoutSeconds, `run ${instanceId} terminal status`).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}; last probe error: ${String(lastError)}`);
  });
  if (ended) throw new Error(`run ${instanceId} ended as ${ended}`);
  return { status };
}

/** Reads runtime and custom status through daprd's HTTP workflow API. */
async function workflowStatus(
  context: Context,
  instanceId: string,
): Promise<{ runtimeStatus: string; customStatus?: string; output?: string; failure?: string }> {
  const response = await fetch(`http://127.0.0.1:${context.httpPort}/v1.0/workflows/dapr/${encodeURIComponent(instanceId)}`);
  if (!response.ok) throw new Error(`workflow status ${response.status}`);
  const body = await response.json() as { runtimeStatus?: string; properties?: Record<string, string> };
  const properties = body.properties ?? {};
  return {
    runtimeStatus: body.runtimeStatus ?? "UNKNOWN",
    ...(properties["dapr.workflow.custom_status"] !== undefined ? { customStatus: properties["dapr.workflow.custom_status"] } : {}),
    ...(properties["dapr.workflow.output"] !== undefined ? { output: properties["dapr.workflow.output"] } : {}),
    ...(properties["dapr.workflow.failure.error_message"] !== undefined
      ? { failure: properties["dapr.workflow.failure.error_message"] } : {}),
  };
}

function parseCustomStatus(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function release(context: Context, instanceId: string): Promise<void> {
  await context.client.terminateWorkflow(instanceId, undefined).catch(() => undefined);
}

async function requestControl(
  context: Context,
  runId: string,
  action: "pause" | "resume" | "replay-task",
  payload: Record<string, unknown> = {},
): Promise<string> {
  const controlId = randomUUID();
  const requested = await context.harness.controls.request({ schemaVersion: 1, controlId, runId, action, payload } as ControlRequestV1);
  if (!requested.ok) throw new Error(`control rejected: ${requested.code}`);
  const accepted = await context.harness.controls.transition(controlId, requested.record.recordVersion, "accepted");
  if (!accepted.ok) throw new Error(`control not accepted: ${accepted.code}`);
  // Accept durably before raising, as RunControlCoordinator does; recovery relies on this order.
  await context.client.raiseEvent(runOrchestrationWorkflowId(runId), RUN_CONTROL_EVENT_NAME, { controlId });
  return controlId;
}

async function controlApplied(context: Context, controlId: string, seconds = 60): Promise<void> {
  try {
    await waitFor(async () => (await context.harness.controls.get(controlId))?.state === "applied", seconds, `control ${controlId} applied`);
  } catch (error) {
    const record = await context.harness.controls.get(controlId);
    const status = record
      ? await workflowStatus(context, runOrchestrationWorkflowId(record.runId)).catch((statusError: unknown) => String(statusError))
      : undefined;
    const generations = record ? context.harness.probes.get(record.runId)?.generations : undefined;
    throw new Error(`${(error as Error).message} (action ${record?.action}, state ${record?.state}, `
      + `generations ${generations}, workflow ${JSON.stringify(status)})`);
  }
}

function childIds(runId: string, taskIds: readonly string[]): string[] {
  return taskIds.map((taskId) => taskAttemptWorkflowIdForAttempt(runId, taskId, 1));
}

async function largeManifest(context: Context, rolloverUnits: number | undefined): Promise<Record<string, unknown>> {
  const settings: Record<string, number> = rolloverUnits === undefined ? {} : { historyRolloverUnits: rolloverUnits };
  const started = Date.now();
  const run = await startRun(context, context.options.tasks, settings, completeAll, 20);
  const sampler = context.meter.sample(() => [run.instanceId]);
  const result = await finish(context, run.instanceId, 900);
  const peaks = await sampler.stop();
  const final = await context.meter.stats([run.instanceId]);
  const probe = context.harness.probe(run.runId);
  const plan = buildOrchestrationPlan(run.submission);
  await release(context, run.instanceId);
  check(result.status === "complete", "large run completes with every task complete");
  check(probe.operations.length === context.options.tasks, "one operation per task");
  check(new Set(probe.operations.map((operation) => operation.operationId)).size === context.options.tasks, "distinct operation IDs");
  check(probe.peak <= plan.maxConcurrency, "per-run concurrency respected");
  return {
    tasks: context.options.tasks,
    concurrency: plan.maxConcurrency,
    historyRolloverUnits: plan.historyRolloverUnits,
    generations: probe.generations,
    wallMs: Date.now() - started,
    peakActiveAttempts: probe.peak,
    runHistoryPeak: peaks[run.instanceId] ?? null,
    runHistoryFinal: final[run.instanceId] ?? null,
    inputBytes: Buffer.byteLength(JSON.stringify(run.submission)),
  };
}

async function retryStorm(context: Context): Promise<Record<string, unknown>> {
  const tasks = 32;
  const failures = 2;
  const started = Date.now();
  context.harness.globalPeak = 0;
  const run = await startRun(context, tasks, { maxRetries: failures, retryDelayMs: 1_000 }, (input) =>
    input.logicalAttempt <= failures
      ? { status: "failed", retryable: true, failureCode: "transient", reason: "storm" }
      : completeAll(input), 50);
  const result = await finish(context, run.instanceId, 600);
  const probe = context.harness.probe(run.runId);
  const sampleChild = taskAttemptWorkflowIdForAttempt(run.runId, "t-0001", 1);
  const childHistory = await context.meter.stats([sampleChild]);
  await release(context, run.instanceId);
  check(result.status === "complete", "storm run completes after retries");
  check(probe.operations.length === tasks * (failures + 1), "every retry is a fresh operation");
  check(new Set(probe.operations.map((operation) => operation.operationId)).size === probe.operations.length, "operation IDs distinct per logical attempt");
  check(probe.peak <= 8, "retries never exceed the run concurrency");
  check(context.harness.globalPeak <= MAX_WORKER_TASK_ATTEMPTS, "worker never exceeds its attempt budget");
  return {
    tasks,
    retriesPerTask: failures,
    operations: probe.operations.length,
    peakActiveAttempts: probe.peak,
    globalPeakActiveAttempts: context.harness.globalPeak,
    generations: probe.generations,
    childHistoryFinal: childHistory[sampleChild] ?? null,
    wallMs: Date.now() - started,
  };
}

async function longWait(context: Context): Promise<Record<string, unknown>> {
  const started = Date.now();
  const run = await startRun(context, 4, { concurrency: 4 }, (input) =>
    input.taskId === "t-0001" ? { status: "waiting", waitId: `wait-${input.operationId}` } : completeAll(input), 20);
  const childId = taskAttemptWorkflowIdForAttempt(run.runId, "t-0001", 1);
  await waitFor(async () => (await workflowStatus(context, childId)).customStatus?.includes("waiting-for-control") ?? false,
    60, "approval wait");
  const ids = [run.instanceId, childId];
  const atWaitStart = await context.meter.stats(ids);
  const half = Math.floor(context.options.waitSeconds / 2) * 1000;
  await sleep(half);
  const beforeRestart = await context.meter.stats(ids);
  await context.restartWorker();
  await sleep(context.options.waitSeconds * 1000 - half);
  const atWaitEnd = await context.meter.stats(ids);
  const waitState = await workflowStatus(context, childId);
  check(waitState.customStatus?.includes("waiting-for-control"), "still waiting after restart");
  check(atWaitEnd[childId]?.rows === atWaitStart[childId]?.rows, "child history does not grow while waiting");
  check(atWaitEnd[run.instanceId]?.rows === atWaitStart[run.instanceId]?.rows, "run history does not grow while waiting");
  await context.client.raiseEvent(childId, TASK_CONTROL_EVENT_NAME, { controlId: randomUUID() });
  const result = await finish(context, run.instanceId, 120);
  await release(context, run.instanceId);
  check(result.status === "complete", "waiting task completes after wake");
  return {
    waitSeconds: context.options.waitSeconds,
    workerRestartedDuringWait: true,
    historyAtWaitStart: atWaitStart,
    historyBeforeRestart: beforeRestart,
    historyAtWaitEnd: atWaitEnd,
    wallMs: Date.now() - started,
  };
}

async function controlsAcrossRollover(context: Context): Promise<Record<string, unknown>> {
  const started = Date.now();
  const tasks = 80;
  const run = await startRun(context, tasks, { concurrency: 2, historyRolloverUnits: 3 }, completeAll, 400);
  const probe = context.harness.probe(run.runId);
  const applied: Array<{ action: string; controlId: string; heldDispatches?: boolean }> = [];
  await waitFor(async () => probe.generations >= 2, 60, "first rollover");
  for (let cycle = 0; cycle < 6; cycle += 1) {
    await sleep(1_200);
    const pause = await requestControl(context, run.runId, "pause");
    if (cycle >= 3) {
      // Burst: the resume is accepted before the pause is applied and may straddle a rollover.
      const resume = await requestControl(context, run.runId, "resume");
      await controlApplied(context, pause);
      await controlApplied(context, resume);
      applied.push({ action: "pause", controlId: pause }, { action: "resume", controlId: resume });
      continue;
    }
    await controlApplied(context, pause);
    await sleep(1_000); // The in-flight wave may still finish after the pause applies.
    const dispatchesWhilePaused = probe.operations.length;
    await sleep(1_500);
    const held = probe.operations.length === dispatchesWhilePaused;
    check(held, "no new dispatch while paused");
    const resume = await requestControl(context, run.runId, "resume");
    await controlApplied(context, resume);
    applied.push({ action: "pause", controlId: pause, heldDispatches: held }, { action: "resume", controlId: resume });
  }
  await waitFor(async () => probe.operations.some((operation) => operation.taskId === "t-0001"), 30, "t-0001 executed");
  const replay = await requestControl(context, run.runId, "replay-task", { taskId: "t-0001" });
  await controlApplied(context, replay);
  applied.push({ action: "replay-task", controlId: replay });
  const result = await finish(context, run.instanceId, 600);
  const final = await context.meter.stats([run.instanceId]);
  const replayed = probe.operations.filter((operation) => operation.taskId === "t-0001");
  await release(context, run.instanceId);
  check(result.status === "complete", "controlled run completes");
  check(applied.every(({ controlId }) => context.harness.controls.records.get(controlId)?.state === "applied"), "every control applied");
  check(probe.generations >= 10, "frequent rollovers occurred");
  check(replayed.length === 2 && replayed[1]!.logicalAttempt === 2
    && replayed[1]!.operationId === taskOperationId(run.runId, "t-0001", 2), "replay keeps task identity with a fresh attempt");
  return {
    tasks,
    historyRolloverUnits: 3,
    generations: probe.generations,
    controls: applied.length,
    controlsApplied: applied,
    replayAttempts: replayed,
    runHistoryFinal: final[run.instanceId] ?? null,
    wallMs: Date.now() - started,
  };
}

async function admission(context: Context): Promise<Record<string, unknown>> {
  const controller = new RunAdmissionController(MAX_WORKER_TASK_ATTEMPTS);
  const starts: Array<{ concurrency: number; admitted: boolean; code?: string }> = [];
  const admitted: Array<{ runId: string; instanceId: string }> = [];
  context.harness.globalPeak = 0;
  for (const concurrency of [4, 4, 4]) {
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const reservation = controller.reserve(runId, concurrency);
    starts.push({ concurrency, admitted: reservation.ok, ...(reservation.ok ? {} : { code: reservation.code }) });
    if (!reservation.ok) continue;
    admitted.push(await startRun(context, 24, { concurrency }, completeAll, 100, runId));
  }
  const snapshotWhileRunning = controller.snapshot();
  const results = await Promise.all(admitted.map((run) => finish(context, run.instanceId, 300)));
  for (const run of admitted) {
    controller.release(run.runId);
    await release(context, run.instanceId);
  }
  check(starts.filter((start) => start.admitted).length === 2, "only two 4-wide runs admitted");
  check(starts[2]?.code === "worker-capacity-exhausted", "third run backpressured");
  check(results.every((result) => result.status === "complete"), "admitted runs complete");
  check(context.harness.globalPeak <= MAX_WORKER_TASK_ATTEMPTS, "global attempts within worker budget");
  return {
    maxActiveTaskAttempts: MAX_WORKER_TASK_ATTEMPTS,
    starts,
    snapshotWhileRunning,
    globalPeakActiveAttempts: context.harness.globalPeak,
    snapshotAfter: controller.snapshot(),
  };
}

async function outcomeBounds(context: Context): Promise<Record<string, unknown>> {
  const oversizedReason = "x".repeat(2 * 1024 * 1024);
  const run = await startRun(context, 2, { concurrency: 2 }, (input) =>
    input.taskId === "t-0001"
      ? boundTaskExecutionOutcome({ status: "failed", retryable: false, failureCode: "huge", reason: oversizedReason })
      : completeAll(input), 20);
  const result = await finish(context, run.instanceId, 120);
  const [failedChild] = childIds(run.runId, ["t-0001"]);
  const childState = await workflowStatus(context, failedChild!);
  const childOutput = JSON.parse(childState.output ?? "{}") as { reason?: string };
  const history = await context.meter.stats([failedChild!]);
  await release(context, run.instanceId);
  check(result.status === "failed", "oversized failure recorded as a failed task");
  check((childOutput.reason?.length ?? Infinity) <= MAX_FAILURE_REASON_CHARS, "reason truncated");
  check((history[failedChild!]?.bytes ?? Infinity) < 128 * 1024, "child history stays small");

  const rejections: Record<string, string> = {};
  try {
    buildOrchestrationPlan(submissionFor(RUN_LIMITS_V1.maxTasksPerRun + 1, {}));
  } catch (error) { rejections.taskCount = (error as Error).message; }
  try {
    const huge = submissionFor(1, {});
    buildOrchestrationPlan({
      ...huge,
      configuration: { ...huge.configuration, settings: { ...huge.configuration.settings, padding: "p".repeat(RUN_LIMITS_V1.maxWorkflowInputBytes) } },
    } as typeof huge);
  } catch (error) { rejections.inputBytes = (error as Error).message; }
  check(rejections.taskCount && rejections.inputBytes, "planner rejects over-limit submissions");
  return {
    oversizedReasonChars: oversizedReason.length,
    storedReasonChars: childOutput.reason?.length,
    failedChildHistory: history[failedChild!] ?? null,
    plannerRejections: rejections,
  };
}

async function main(): Promise<void> {
  if (process.env.MEASURE_VERBOSE !== "1") quietDurableTaskInfo();
  const options = parseOptions(process.argv.slice(2));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "myforge-p4-06-dapr-"));
  const harness = new Harness();
  let stack: DaprStack | undefined;
  let runtime: WorkflowRuntime | undefined;
  let client: DaprWorkflowClient | undefined;
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    gate: "P4-06",
    generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, node: process.version, dapr: IMAGES.daprd, podman: await podman(["--version"]) },
    limits: { run: RUN_LIMITS_V1, sdkWorker: DAPR_SDK_WORKER_LIMITS, maxWorkerTaskAttempts: MAX_WORKER_TASK_ATTEMPTS },
    scenarios: [] as unknown[],
  };
  try {
    stack = await startDapr(runtimeRoot, "p4-06");
    const daprAddress = { daprHost: "127.0.0.1", daprPort: String(stack.grpcPort) };
    const startWorker = async () => {
      const next = harness.register(new WorkflowRuntime(daprAddress));
      await next.start();
      return next;
    };
    runtime = await startWorker();
    client = new DaprWorkflowClient(daprAddress);
    const meter = await HistoryMeter.create(stack.pod);
    const context: Context = {
      harness,
      client,
      meter,
      options,
      httpPort: stack.httpPort,
      restartWorker: async () => {
        await runtime?.stop();
        runtime = await startWorker();
      },
    };
    const scenarios: Array<[string, string, () => Promise<Record<string, unknown>>]> = [
      ["large-manifest-default-rollover", "A large run rolls history over at the default unit budget and completes.", () => largeManifest(context, undefined)],
      ["large-manifest-no-rollover", "Baseline: the same run with rollover at the maximum unit budget.", () => largeManifest(context, RUN_LIMITS_V1.maxHistoryRolloverUnits)],
      ["retry-storm", "Retry storms stay within run concurrency and allocate a fresh operation per attempt.", () => retryStorm(context)],
      ["long-approval-wait", "A long wait adds no history and survives a worker restart.", () => longWait(context)],
      ["controls-across-rollover", "Pause/resume/replay controls are not lost across frequent continue-as-new.", () => controlsAcrossRollover(context)],
      ["run-admission", "Run admission backpressures starts beyond the worker attempt budget.", () => admission(context)],
      ["outcome-and-input-bounds", "Oversized outcomes and submissions are bounded before entering history.", () => outcomeBounds(context)],
    ];
    for (const [name, proves, scenario] of scenarios.filter(([name]) => !options.only || name === options.only)) {
      process.stdout.write(`▶ ${name}\n`);
      const started = Date.now();
      try {
        const measurements = await scenario();
        (evidence.scenarios as unknown[]).push({ name, proves, passed: true, durationMs: Date.now() - started, measurements });
        process.stdout.write(`  ✔ ${name} ${JSON.stringify(measurements).slice(0, 400)}\n`);
      } catch (error) {
        (evidence.scenarios as unknown[]).push({ name, proves, passed: false, durationMs: Date.now() - started, error: String(error) });
        process.stdout.write(`  ✖ ${name}: ${String(error)}\n`);
      }
    }
    evidence.passed = (evidence.scenarios as { passed: boolean }[]).every((scenario) => scenario.passed);
  } catch (error) {
    evidence.passed = false;
    evidence.error = String(error);
  } finally {
    await runtime?.stop().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    await stack?.remove();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
  await mkdir(dirname(options.evidence), { recursive: true });
  await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Evidence: ${options.evidence}\n`);
  if (!evidence.passed) {
    process.stdout.write(`${String(evidence.error ?? "one or more scenarios failed")}\n`);
    process.exitCode = 1;
  }
}

await main();
