import { createHash } from "node:crypto";
import type { Task, WorkflowContext } from "@dapr/dapr";
import type {
  RunLifecycleEventInputV1,
  RunLifecycleEventV1,
  Sha256Digest,
  TaskStatusV1,
} from "../contract/v1/index.ts";
import {
  buildOrchestrationPlan,
  nextDispatchWave,
  type AcceptedRunSubmissionV1,
} from "./planner.ts";
import {
  isTaskGateResults,
  isTaskCompletionEvidence,
  type TaskExecutionOutcomeV1,
  type TaskExecutionIdentityV1,
} from "./outcome.ts";
import { RUN_LIMITS_V1 } from "./limits.ts";
export type { TaskExecutionOutcomeV1 } from "./outcome.ts";

export interface RunWorkflowInputV1 {
  readonly runId: string;
  readonly submission: AcceptedRunSubmissionV1;
  /** Required: true only when the host registers durable control activities. */
  readonly controlsEnabled: boolean;
  /** The host registers the durable status activity and pre-creates the run record. */
  readonly statusEnabled: boolean;
  /** Present only on a generation started by continue-as-new. */
  readonly continuation?: RunContinuationV1;
}

/** Run progress carried across a continue-as-new history rollover. */
export interface RunContinuationV1 {
  readonly schemaVersion: 1;
  /** 1 for the first continued generation. */
  readonly generation: number;
  readonly statuses: Readonly<Record<string, TaskStatusV1>>;
  readonly nextLogicalAttempt: Readonly<Record<string, number>>;
  readonly runCycle: number;
}

export interface TaskAttemptWorkflowInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly allowNoop: boolean;
  readonly initialLogicalAttempt?: number;
  readonly statusEnabled: boolean;
}

export interface ExecuteTaskActivityInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly allowNoop: boolean;
}

export interface ResumeTaskActivityInputV1 extends ExecuteTaskActivityInputV1 {
  readonly waitId: string;
  readonly controlId: string;
  readonly taskWorkflowInstanceId: string;
}

export interface TaskWaitRequestV1 {
  readonly status: "waiting";
  readonly waitId: string;
}

export interface TaskControlWakeEventV1 {
  readonly controlId: string;
}

export type TaskActivityOutcomeV1 = TaskExecutionOutcomeV1 | TaskWaitRequestV1;

export interface RunWorkflowResultV1 {
  /** "continued" is the discarded result of a generation that rolled its history over. */
  readonly status: "complete" | "failed" | "cancelled" | "continued";
  readonly taskStatuses: Readonly<Record<string, TaskStatusV1>>;
}

export interface RunControlRecordSummaryV1 {
  readonly controlId: string;
  readonly runId: string;
  readonly action: "pause" | "resume" | "stop" | "cancel" | "replay-task";
  readonly state: "accepted" | "applied";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AppliedRunControlV1 extends RunControlRecordSummaryV1 {
  readonly state: "applied";
  readonly replayLogicalAttempt?: number;
}

const UUID_NAMESPACE = Buffer.from("8bb1c6bb6d754bd49fc10f645ffb8b0c", "hex");

export const RUN_ORCHESTRATION_WORKFLOW_NAME = "runOrchestrationWorkflow";
export const TASK_ATTEMPT_WORKFLOW_NAME = "taskAttemptWorkflow";
export const EXECUTE_TASK_ACTIVITY_NAME = "executeTask";
export const RESUME_TASK_ACTIVITY_NAME = "resumeTask";
export const TASK_CONTROL_EVENT_NAME = "task-control";
export const RUN_CONTROL_EVENT_NAME = "run-control";
export const RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME = "recordRunLifecycleEvent";
export const GET_RUN_CONTROL_ACTIVITY_NAME = "getRunControl";
export const APPLY_RUN_CONTROL_ACTIVITY_NAME = "applyRunControl";
export const LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME = "listAcceptedRunControls";
/** Accepted controls a continued generation recovers in one pass; more remain accepted for the next. */
export const MAX_RECOVERED_RUN_CONTROLS = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function runOrchestrationWorkflowId(runId: string): string {
  return `forge-run-${taskOperationId(runId, "_run", 1, "orchestration")}`;
}

/** UUIDv5 identity makes a task operation stable across workflow replay. */
export function taskOperationId(
  runId: string,
  taskId: string,
  logicalAttempt: number,
  operationKind = "execute",
): string {
  if (typeof runId !== "string" || runId.length === 0
    || typeof taskId !== "string" || taskId.length === 0
    || !Number.isSafeInteger(logicalAttempt) || logicalAttempt < 1
    || typeof operationKind !== "string" || operationKind.length === 0) {
    throw new Error("operation identity requires runId, taskId, and a positive logicalAttempt");
  }
  const digest = createHash("sha1")
    .update(UUID_NAMESPACE)
    .update(`${runId.length}:${runId}${taskId.length}:${taskId}${logicalAttempt}:${operationKind.length}:${operationKind}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isTaskExecutionOutcome(
  value: unknown,
  expected?: TaskExecutionIdentityV1,
): value is TaskExecutionOutcomeV1 {
  if (!value || typeof value !== "object" || !("status" in value)) return false;
  const outcome = value as {
    status?: unknown;
    retryable?: unknown;
    failureCode?: unknown;
    reason?: unknown;
    gates?: unknown;
    evidence?: unknown;
  };
  return (outcome.status === "complete" && isTaskCompletionEvidence(outcome.evidence, expected))
    || outcome.status === "skipped"
    || (outcome.status === "failed" && typeof outcome.retryable === "boolean"
      && (outcome.failureCode === undefined || typeof outcome.failureCode === "string")
      && (outcome.reason === undefined || typeof outcome.reason === "string")
      && (outcome.gates === undefined || isTaskGateResults(outcome.gates)));
}

function isTaskActivityOutcome(
  value: unknown,
  expected?: TaskExecutionIdentityV1,
): value is TaskActivityOutcomeV1 {
  if (isTaskExecutionOutcome(value, expected)) return true;
  if (!value || typeof value !== "object" || !("status" in value) || !("waitId" in value)) return false;
  const outcome = value as { status?: unknown; waitId?: unknown };
  return outcome.status === "waiting" && typeof outcome.waitId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(outcome.waitId);
}

function isTaskControlWakeEvent(value: unknown): value is TaskControlWakeEventV1 {
  if (!value || typeof value !== "object" || !("controlId" in value)) return false;
  const controlId = (value as { controlId?: unknown }).controlId;
  return typeof controlId === "string" && UUID_PATTERN.test(controlId);
}

function validateTaskAttemptInput(input: TaskAttemptWorkflowInputV1): void {
  if (!input.runId || !input.taskId
    || !/^sha256:[0-9a-f]{64}$/.test(input.manifestDigest)
    || !Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0
    || !Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0
    || typeof input.allowNoop !== "boolean"
    || typeof input.statusEnabled !== "boolean"
    || (input.initialLogicalAttempt !== undefined &&
      (!Number.isSafeInteger(input.initialLogicalAttempt) || input.initialLogicalAttempt < 1))) {
    throw new Error("Invalid task attempt workflow input");
  }
}

function* recordLifecycleEvent(
    context: WorkflowContext,
    enabled: boolean,
    event: RunLifecycleEventInputV1,
  ): Generator<Task<unknown>, void, unknown> {
    if (!enabled) return;
    const recorded: unknown = yield context.callActivity(RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME, event);
    if (!recorded || typeof recorded !== "object") {
      throw new Error("recordRunLifecycleEvent returned an invalid event");
    }
    const result = recorded as Partial<RunLifecycleEventV1>;
    if (result.schemaVersion !== 1 || result.runId !== event.runId
      || result.eventKey !== event.eventKey || result.eventType !== event.eventType
      || !Number.isSafeInteger(result.sequence) || result.sequence! < 1
      || typeof result.createdAt !== "string") {
      throw new Error("recordRunLifecycleEvent returned a mismatched event");
    }
  }

function* recordCancelledTasks(
    context: WorkflowContext,
    enabled: boolean,
    runId: string,
    statuses: Readonly<Record<string, TaskStatusV1>>,
    controlId: string,
  ): Generator<Task<unknown>, void, unknown> {
    for (const [taskId, status] of Object.entries(statuses)) {
      if (status !== "pending" && status !== "ready" && status !== "running"
        && status !== "waiting-for-approval") continue;
      yield* recordLifecycleEvent(context, enabled, {
        schemaVersion: 1,
        runId,
        eventKey: taskEventKey(taskId, `cancelled:${controlId}`),
        eventType: "task.cancelled",
        taskId,
        taskStatus: "cancelled",
        detail: { controlId },
      });
    }
  }

function* recordReplay(
  context: WorkflowContext,
  enabled: boolean,
  runId: string,
  taskId: string,
  logicalAttempt: number,
  controlId: string,
  reopenRun: boolean,
): Generator<Task<unknown>, void, unknown> {
  if (reopenRun) {
    yield* recordLifecycleEvent(context, enabled, {
      schemaVersion: 1,
      runId,
      eventKey: `run:reopened:${controlId}`,
      eventType: "run.reopened",
      runStatus: "running",
      detail: { controlId },
    });
  }
    yield* recordLifecycleEvent(context, enabled, {
      schemaVersion: 1,
      runId,
      eventKey: taskEventKey(taskId, `replayed:${controlId}`),
      eventType: "task.replayed",
      taskId,
      logicalAttempt,
      taskStatus: "pending",
      detail: { controlId },
    });
  }

function taskEventKey(taskId: string, suffix: string): string {
  const taskDigest = createHash("sha256").update(taskId).digest("hex");
  return `task:${taskDigest}:${suffix}`;
}

function isRunControlWakeEvent(value: unknown): value is TaskControlWakeEventV1 {
  return isTaskControlWakeEvent(value);
}

function isRunControlRecord(
  value: unknown,
  runId: string,
): value is RunControlRecordSummaryV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunControlRecordSummaryV1>;
  return record.runId === runId
    && typeof record.controlId === "string"
    && (record.action === "pause" || record.action === "resume" || record.action === "stop"
      || record.action === "cancel" || record.action === "replay-task")
    && (record.state === "accepted" || record.state === "applied")
    && !!record.payload && typeof record.payload === "object";
}

function isAppliedRunControl(value: unknown): value is AppliedRunControlV1 {
  return isRunControlRecord(value, (value as Partial<RunControlRecordSummaryV1> | null)?.runId ?? "")
    && (value as Partial<AppliedRunControlV1>).state === "applied";
}

function cancelUnfinishedTasks(statuses: Record<string, TaskStatusV1>): void {
  for (const [taskId, status] of Object.entries(statuses)) {
    if (status === "pending" || status === "ready" || status === "running"
      || status === "waiting-for-approval") {
      statuses[taskId] = "cancelled";
    }
  }
}

/** One child workflow owns retries; each accepted retry gets a new logical operation. */
export async function* taskAttemptWorkflow(
  context: WorkflowContext,
  input: TaskAttemptWorkflowInputV1,
): AsyncGenerator<Task<unknown>, TaskExecutionOutcomeV1, unknown> {
  validateTaskAttemptInput(input);
  for (let retry = 0; retry <= input.maxRetries; retry += 1) {
    const logicalAttempt = (input.initialLogicalAttempt ?? 1) + retry;
    yield* recordLifecycleEvent(context, input.statusEnabled, {
      schemaVersion: 1,
      runId: input.runId,
      eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:started`),
      eventType: "attempt.started",
      taskId: input.taskId,
      logicalAttempt,
      taskStatus: "running",
      attemptStatus: "running",
    });
    const activityInput: ExecuteTaskActivityInputV1 = {
      runId: input.runId,
      taskId: input.taskId,
      manifestDigest: input.manifestDigest,
      logicalAttempt,
      operationId: taskOperationId(input.runId, input.taskId, logicalAttempt),
      allowNoop: input.allowNoop,
    };
    let activityOutcome: unknown;
    try {
      activityOutcome = yield context.callActivity(EXECUTE_TASK_ACTIVITY_NAME, activityInput);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // An activity exception may follow an external effect; do not retry it as a new operation.
      yield* recordLifecycleEvent(context, input.statusEnabled, {
        schemaVersion: 1,
        runId: input.runId,
        eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:activity-failed`),
        eventType: "task.failed",
        taskId: input.taskId,
        logicalAttempt,
        taskStatus: "failed",
        attemptStatus: "failed",
        detail: { failureCode: "activity-failed" },
      });
      return { status: "failed", retryable: false, failureCode: "activity-failed" };
    }
    if (!isTaskActivityOutcome(activityOutcome, activityInput)) throw new Error("executeTask returned an invalid outcome");
    let outcome: TaskActivityOutcomeV1 = activityOutcome;
    let waitCount = 0;
    const taskWorkflowInstanceId = taskAttemptWorkflowIdForAttempt(
      input.runId,
      input.taskId,
      input.initialLogicalAttempt ?? 1,
    );
    while (outcome.status === "waiting") {
      waitCount += 1;
      if (waitCount > RUN_LIMITS_V1.maxApprovalWaitsPerAttempt) {
        // Each approval round adds history; an attempt that keeps re-entering approval fails closed.
        yield* recordLifecycleEvent(context, input.statusEnabled, {
          schemaVersion: 1,
          runId: input.runId,
          eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:wait-limit-exceeded`),
          eventType: "task.failed",
          taskId: input.taskId,
          logicalAttempt,
          taskStatus: "failed",
          attemptStatus: "failed",
          detail: { failureCode: "wait-limit-exceeded" },
        });
        return { status: "failed", retryable: false, failureCode: "wait-limit-exceeded" };
      }
      yield* recordLifecycleEvent(context, input.statusEnabled, {
        schemaVersion: 1,
        runId: input.runId,
        eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:wait:${waitCount}`),
        eventType: "attempt.waiting-for-approval",
        taskId: input.taskId,
        logicalAttempt,
        taskStatus: "waiting-for-approval",
        attemptStatus: "waiting-for-approval",
        detail: { waitId: outcome.waitId, taskWorkflowInstanceId },
      });
      context.setCustomStatus("waiting-for-control");
      const wakeEvent: unknown = yield context.waitForExternalEvent(TASK_CONTROL_EVENT_NAME);
      if (!isTaskControlWakeEvent(wakeEvent)) {
        throw new Error("task-control event must contain a UUID controlId");
      }
      const resumeInput: ResumeTaskActivityInputV1 = {
        ...activityInput,
        waitId: outcome.waitId,
        controlId: wakeEvent.controlId,
        operationId: taskOperationId(input.runId, input.taskId, logicalAttempt, `resume:${outcome.waitId}`),
        taskWorkflowInstanceId,
      };
      yield* recordLifecycleEvent(context, input.statusEnabled, {
        schemaVersion: 1,
        runId: input.runId,
        eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:resumed:${wakeEvent.controlId}`),
        eventType: "attempt.resumed",
        taskId: input.taskId,
        logicalAttempt,
        taskStatus: "running",
        attemptStatus: "running",
      });
      let resumedOutcome: unknown;
      try {
        resumedOutcome = yield context.callActivity(RESUME_TASK_ACTIVITY_NAME, resumeInput);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        yield* recordLifecycleEvent(context, input.statusEnabled, {
          schemaVersion: 1,
          runId: input.runId,
          eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:resume-failed:${wakeEvent.controlId}`),
          eventType: "task.failed",
          taskId: input.taskId,
          logicalAttempt,
          taskStatus: "failed",
          attemptStatus: "failed",
          detail: { failureCode: "resume-activity-failed" },
        });
        return { status: "failed", retryable: false, failureCode: "resume-activity-failed" };
      }
      if (!isTaskActivityOutcome(resumedOutcome, resumeInput)) throw new Error("resumeTask returned an invalid outcome");
      outcome = resumedOutcome;
    }
    const retrying = outcome.status === "failed" && outcome.retryable && retry < input.maxRetries;
    yield* recordLifecycleEvent(context, input.statusEnabled, {
      schemaVersion: 1,
      runId: input.runId,
      eventKey: taskEventKey(input.taskId, `attempt:${logicalAttempt}:finished`),
      eventType: retrying ? "attempt.failed" : `task.${outcome.status === "complete" ? "completed" : outcome.status}`,
      taskId: input.taskId,
      logicalAttempt,
      ...(retrying ? {} : { taskStatus: outcome.status }),
      attemptStatus: outcome.status === "complete" ? "complete"
        : outcome.status === "skipped" ? "skipped" : "failed",
      ...(outcome.status === "failed" && outcome.failureCode ? { detail: { failureCode: outcome.failureCode } } : {}),
    });
    if (!retrying) return outcome;

    const deadline = context.getCurrentUtcDateTime().getTime() + input.retryDelayMs;
    if (!Number.isSafeInteger(deadline)) throw new Error("retry timer deadline exceeds the safe timestamp range");
    const fireAt = new Date(deadline);
    if (!Number.isFinite(fireAt.getTime())) throw new Error("retry timer deadline is outside the supported date range");
    yield context.createTimer(fireAt);
  }
  throw new Error("Task retry loop exited without an outcome");
}

export function taskAttemptWorkflowId(runId: string, taskId: string): string {
  return taskAttemptWorkflowIdForAttempt(runId, taskId, 1);
}

export function taskAttemptWorkflowIdForAttempt(
  runId: string,
  taskId: string,
  logicalAttempt: number,
): string {
  return `forge-task-${taskOperationId(runId, taskId, logicalAttempt)}`;
}

const CONTINUABLE_TASK_STATUSES: ReadonlySet<unknown> = new Set(["pending", "complete", "skipped", "failed"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validates carried progress against the immutable plan; a continued run always has pending work. */
function restoreContinuation(
  continuation: unknown,
  taskIds: readonly string[],
): RunContinuationV1 {
  if (!isPlainRecord(continuation) || continuation.schemaVersion !== 1
    || !Number.isSafeInteger(continuation.generation) || (continuation.generation as number) < 1
    || !Number.isSafeInteger(continuation.runCycle) || (continuation.runCycle as number) < 0
    || !isPlainRecord(continuation.statuses) || !isPlainRecord(continuation.nextLogicalAttempt)
    || Object.keys(continuation.statuses).length !== taskIds.length
    || Object.keys(continuation.nextLogicalAttempt).length !== taskIds.length) {
    throw new Error("Invalid run continuation");
  }
  const statuses = continuation.statuses;
  const attempts = continuation.nextLogicalAttempt;
  for (const taskId of taskIds) {
    if (!Object.hasOwn(statuses, taskId) || !CONTINUABLE_TASK_STATUSES.has(statuses[taskId])
      || !Object.hasOwn(attempts, taskId) || !Number.isSafeInteger(attempts[taskId])
      || (attempts[taskId] as number) < 1) {
      throw new Error(`Invalid run continuation for task '${taskId}'`);
    }
  }
  if (!Object.values(statuses).includes("pending")) throw new Error("A continued run must have pending tasks");
  return continuation as unknown as RunContinuationV1;
}

/** Runs manifest-ordered task waves and only dispatches dependency-ready work. */
export async function* runOrchestrationWorkflow(
  context: WorkflowContext,
  input: RunWorkflowInputV1,
): AsyncGenerator<Task<unknown>, RunWorkflowResultV1, unknown> {
  if (!input.runId) throw new Error("runId is required");
  if (typeof input.controlsEnabled !== "boolean") throw new Error("controlsEnabled must be explicit");
  if (typeof input.statusEnabled !== "boolean") throw new Error("statusEnabled must be explicit");
  const plan = buildOrchestrationPlan(input.submission);
  const continuation = input.continuation === undefined
    ? undefined
    : restoreContinuation(input.continuation, plan.tasks.map(({ taskId }) => taskId));
  const statuses: Record<string, TaskStatusV1> = continuation
    ? { ...continuation.statuses }
    : Object.fromEntries(plan.tasks.map(({ taskId }) => [taskId, "pending"]));
  const nextLogicalAttempt: Record<string, number> = continuation
    ? { ...continuation.nextLogicalAttempt }
    : Object.fromEntries(plan.tasks.map(({ taskId }) => [taskId, 1]));
  const generation = continuation?.generation ?? 0;

  let pendingControlEvent: Task<unknown> | undefined = input.controlsEnabled
    ? context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME)
    : undefined;
  /** Accepted controls recovered from the durable store; processed before new wake events. */
  const queuedControlIds: string[] = [];
  /** Child dispatches plus processed control wakes since this generation started. */
  let historyUnits = 0;
  // Keep at most one outstanding run-control waiter; an orphaned waiter would swallow a wake.
  const armControlWait = (): void => {
    if (input.controlsEnabled && !pendingControlEvent) {
      pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
    }
  };
  function* nextControlWake(): Generator<Task<unknown>, TaskControlWakeEventV1, unknown> {
    historyUnits += 1;
    const queued = queuedControlIds.shift();
    if (queued !== undefined) return { controlId: queued };
    const waiter = pendingControlEvent ?? context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
    pendingControlEvent = undefined;
    const wake: unknown = yield waiter;
    if (!isRunControlWakeEvent(wake)) throw new Error("run-control event must contain a UUID controlId");
    return wake;
  }

  let runCycle = continuation?.runCycle ?? 0;
  if (continuation) {
    if (input.controlsEnabled) {
      // A wake raised while the previous generation rolled over may not be carried over.
      const recovered: unknown = yield context.callActivity(LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME, {
        runId: input.runId,
      });
      if (!Array.isArray(recovered) || recovered.length > MAX_RECOVERED_RUN_CONTROLS
        || !recovered.every((controlId) => typeof controlId === "string" && UUID_PATTERN.test(controlId))) {
        throw new Error("listAcceptedRunControls returned invalid control IDs");
      }
      queuedControlIds.push(...recovered as string[]);
    }
    context.setCustomStatus("running");
  } else {
    yield* recordLifecycleEvent(context, input.statusEnabled, {
      schemaVersion: 1,
      runId: input.runId,
      eventKey: "run:started",
      eventType: "run.started",
      runStatus: "running",
    });
  }
  while (true) {
    while (Object.values(statuses).some((status) => status === "pending")) {
      if (historyUnits >= plan.historyRolloverUnits && queuedControlIds.length === 0
        && !(pendingControlEvent?.isComplete ?? false)) {
        // Task boundary with no wave or child in flight: carry progress into a fresh history.
        const next: RunWorkflowInputV1 = {
          runId: input.runId,
          submission: input.submission,
          controlsEnabled: input.controlsEnabled,
          statusEnabled: input.statusEnabled,
          continuation: {
            schemaVersion: 1,
            generation: generation + 1,
            statuses: { ...statuses },
            nextLogicalAttempt: { ...nextLogicalAttempt },
            runCycle,
          },
        };
        context.continueAsNew(next, true);
        return { status: "continued", taskStatuses: statuses };
      }
      const wave = nextDispatchWave(plan.tasks, statuses, plan.maxConcurrency);
      if (wave.length === 0) {
        if (Object.values(statuses).some((status) => status === "failed")) break;
        throw new Error("No task is ready while pending tasks remain");
      }
      historyUnits += wave.length;

      const children = wave.map(({ taskId }) => {
        const logicalAttempt = nextLogicalAttempt[taskId]!;
        return context.callChildWorkflow<TaskAttemptWorkflowInputV1, TaskExecutionOutcomeV1>(
          TASK_ATTEMPT_WORKFLOW_NAME,
          {
            runId: input.runId,
            taskId,
            manifestDigest: input.submission.manifestDigest,
            maxRetries: plan.maxRetries,
            retryDelayMs: plan.retryDelayMs,
            allowNoop: plan.allowNoop,
            initialLogicalAttempt: logicalAttempt,
            statusEnabled: input.statusEnabled,
          },
          taskAttemptWorkflowIdForAttempt(input.runId, taskId, logicalAttempt),
        );
      });
      // Mock tasks in unit tests lack the isComplete getter; treat that as still running.
      const childDone = (child: Task<unknown>): boolean => child.isComplete ?? false;
      function* awaitWave(): Generator<Task<unknown>, TaskExecutionOutcomeV1[], unknown> {
        // Dapr JS SDK 3.18's WhenAllTask resets its completed count after the base constructor
        // counts already-finished children, so a whenAll over a partly finished wave never
        // completes. Wait only on children that are still running.
        const running = children.filter((child) => !childDone(child));
        if (running.length === 0) return children.map((child) => child.getResult() as TaskExecutionOutcomeV1);
        const runningResults = (yield context.whenAll(running)) as TaskExecutionOutcomeV1[];
        let next = 0;
        return children.map((child) => (running.includes(child)
          ? runningResults[next++]!
          : child.getResult() as TaskExecutionOutcomeV1));
      }
      let outcomes: TaskExecutionOutcomeV1[] | undefined;
      const boundaryControls: RunControlRecordSummaryV1[] = [];
      let wake: TaskControlWakeEventV1 | undefined;

      if (queuedControlIds.length > 0) {
        wake = yield* nextControlWake();
      } else if (pendingControlEvent) {
        // Race the children directly: in Dapr JS SDK 3.18 a completed WhenAllTask never notifies
        // its parent, so whenAny([whenAll(children), event]) cannot resolve through the wave.
        const controlEvent: Task<unknown> = pendingControlEvent;
        while (outcomes === undefined && wake === undefined) {
          const running = children.filter((child) => !childDone(child));
          if (running.length === 0) {
            outcomes = children.map((child) => child.getResult());
            break;
          }
          const winner = yield context.whenAny([...running, controlEvent]);
          if (!winner || typeof winner !== "object" || !("getResult" in winner)) {
            throw new Error("Run workflow whenAny returned an invalid task");
          }
          const completedTask = winner as Task<unknown>;
          if (completedTask === controlEvent) {
            const result = completedTask.getResult();
            pendingControlEvent = undefined;
            historyUnits += 1;
            if (!isRunControlWakeEvent(result)) {
              throw new Error("run-control event must contain a UUID controlId");
            }
            wake = result;
          } else if (!(running as readonly Task<unknown>[]).includes(completedTask)) {
            throw new Error("Run workflow whenAny returned an unrelated task");
          }
        }
      } else {
        outcomes = yield* awaitWave();
      }

      if (wake) {
          const record: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
            controlId: wake.controlId,
          });
          if (!isRunControlRecord(record, input.runId) || record.controlId !== wake.controlId) {
            throw new Error("getRunControl returned a mismatched control record");
          }
          if (record.state === "applied" && record.action !== "cancel") {
            armControlWait();
            outcomes = yield* awaitWave();
          } else {
            if (record.action === "cancel") {
              yield* recordLifecycleEvent(context, input.statusEnabled, {
                schemaVersion: 1,
                runId: input.runId,
                eventKey: `run:cancelling:${record.controlId}`,
                eventType: "run.cancelling",
                runStatus: "cancelling",
                detail: { controlId: record.controlId },
              });
              const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                controlId: record.controlId,
              });
              if (!isAppliedRunControl(applied) || applied.controlId !== record.controlId) {
                throw new Error("applyRunControl returned an invalid cancellation result");
              }
              yield* recordCancelledTasks(context, input.statusEnabled, input.runId, statuses, record.controlId);
              cancelUnfinishedTasks(statuses);
              yield* recordLifecycleEvent(context, input.statusEnabled, {
                schemaVersion: 1,
                runId: input.runId,
                eventKey: `run:cancelled:${record.controlId}`,
                eventType: "run.cancelled",
                runStatus: "cancelled",
                detail: { controlId: record.controlId },
              });
              return { status: "cancelled", taskStatuses: statuses };
            }

            if (record.action === "pause" || record.action === "stop") {
              yield* recordLifecycleEvent(context, input.statusEnabled, {
                schemaVersion: 1,
                runId: input.runId,
                eventKey: `run:${record.action === "stop" ? "stopping" : "pausing"}:${record.controlId}`,
                eventType: record.action === "stop" ? "run.stopping" : "run.pausing",
                runStatus: record.action === "stop" ? "stopping" : "pausing",
                detail: { controlId: record.controlId },
              });
              const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                controlId: record.controlId,
              });
              if (!isAppliedRunControl(applied) || applied.controlId !== record.controlId) {
                throw new Error("applyRunControl returned an invalid pause/stop result");
              }
              yield* recordLifecycleEvent(context, input.statusEnabled, {
                schemaVersion: 1,
                runId: input.runId,
                eventKey: `run:paused:${record.controlId}`,
                eventType: record.action === "stop" ? "run.stopped" : "run.paused",
                runStatus: "paused",
                detail: { controlId: record.controlId },
              });
              context.setCustomStatus("paused");
              while (true) {
                const resumeWake = yield* nextControlWake();
                const resumeRecord: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
                  controlId: resumeWake.controlId,
                });
                if (!isRunControlRecord(resumeRecord, input.runId)
                  || resumeRecord.controlId !== resumeWake.controlId) {
                  throw new Error("getRunControl returned a mismatched control record");
                }
                if (resumeRecord.state === "applied") continue;
                if (resumeRecord.action === "cancel") {
                  yield* recordLifecycleEvent(context, input.statusEnabled, {
                    schemaVersion: 1,
                    runId: input.runId,
                    eventKey: `run:cancelling:${resumeRecord.controlId}`,
                    eventType: "run.cancelling",
                    runStatus: "cancelling",
                    detail: { controlId: resumeRecord.controlId },
                  });
                }
                const resumeResult: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                  controlId: resumeRecord.controlId,
                });
                if (!isAppliedRunControl(resumeResult) || resumeResult.controlId !== resumeRecord.controlId) {
                  throw new Error("applyRunControl returned an invalid result");
                }
                if (resumeRecord.action === "resume") {
                  yield* recordLifecycleEvent(context, input.statusEnabled, {
                    schemaVersion: 1,
                    runId: input.runId,
                    eventKey: `run:resumed:${resumeRecord.controlId}`,
                    eventType: "run.resumed",
                    runStatus: "running",
                    detail: { controlId: resumeRecord.controlId },
                  });
                  break;
                }
                if (resumeRecord.action === "cancel") {
                  yield* recordCancelledTasks(context, input.statusEnabled, input.runId, statuses, resumeRecord.controlId);
                  cancelUnfinishedTasks(statuses);
                  yield* recordLifecycleEvent(context, input.statusEnabled, {
                    schemaVersion: 1,
                    runId: input.runId,
                    eventKey: `run:cancelled:${resumeRecord.controlId}`,
                    eventType: "run.cancelled",
                    runStatus: "cancelled",
                    detail: { controlId: resumeRecord.controlId },
                  });
                  return { status: "cancelled", taskStatuses: statuses };
                }
                if (resumeRecord.action === "replay-task") boundaryControls.push(resumeRecord);
                else throw new Error("Only resume, cancel, or replay-task is valid while paused");
              }
              context.setCustomStatus("running");
              outcomes = yield* awaitWave();
            } else {
              boundaryControls.push(record);
              outcomes = yield* awaitWave();
            }
          }
      }

      if (!Array.isArray(outcomes) || outcomes.length !== wave.length) {
        throw new Error("Task workflow wave returned an invalid outcome set");
      }
      outcomes.forEach((outcome, index) => {
        if (!isTaskExecutionOutcome(outcome, {
          runId: input.runId,
          taskId: wave[index]!.taskId,
          manifestDigest: input.submission.manifestDigest,
        })) throw new Error(`Task '${wave[index]!.taskId}' returned an invalid outcome`);
        statuses[wave[index]!.taskId] = outcome.status;
      });

      if (boundaryControls.length > 0) {
        for (const boundaryControl of boundaryControls) {
          const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
            controlId: boundaryControl.controlId,
          });
          if (!isAppliedRunControl(applied) || applied.controlId !== boundaryControl.controlId) {
            throw new Error("applyRunControl returned an invalid result");
          }
          if (boundaryControl.action !== "replay-task") {
            throw new Error("Only replay-task may be deferred to the task boundary");
          }
          const taskId = boundaryControl.payload.taskId;
          if (typeof taskId !== "string" || !(taskId in statuses)) {
            throw new Error("replay-task control has no valid taskId");
          }
          if (!Number.isSafeInteger(applied.replayLogicalAttempt) || applied.replayLogicalAttempt! < 1) {
            throw new Error("replay-task result has no valid logicalAttempt");
          }
          statuses[taskId] = "pending";
          nextLogicalAttempt[taskId] = applied.replayLogicalAttempt!;
          yield* recordReplay(
            context, input.statusEnabled, input.runId, taskId,
            applied.replayLogicalAttempt!, boundaryControl.controlId, false,
          );
        }
        armControlWait();
      } else if (input.controlsEnabled && !pendingControlEvent) {
        armControlWait();
      } else if (outcomes.some((outcome) => outcome.status === "failed")) {
        break;
      }
    }

    const failed = Object.values(statuses).some((status) => status === "failed");
    const terminalStatus = failed ? "failed" : "complete";
    yield* recordLifecycleEvent(context, input.statusEnabled, {
      schemaVersion: 1,
      runId: input.runId,
      eventKey: `run:terminal:${runCycle}`,
      eventType: terminalStatus === "complete" ? "run.completed" : "run.failed",
      runStatus: terminalStatus,
    });
    if (!input.controlsEnabled) {
      return { status: terminalStatus, taskStatuses: statuses };
    }
    context.setCustomStatus(terminalStatus);
    const wake = yield* nextControlWake();
    const record: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
      controlId: wake.controlId,
    });
    if (!isRunControlRecord(record, input.runId) || record.controlId !== wake.controlId) {
      throw new Error("getRunControl returned a mismatched control record");
    }
    if (record.state === "applied") {
      // A duplicate wake (for example one recovered after a rollover) for an applied control.
      armControlWait();
      continue;
    }
    if (record.action !== "replay-task") {
      throw new Error("Only a valid replay-task control can reopen a terminal run");
    }
    const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
      controlId: record.controlId,
    });
    if (!isAppliedRunControl(applied) || applied.controlId !== record.controlId) {
      throw new Error("applyRunControl returned an invalid replay result");
    }
    const taskId = record.payload.taskId;
    if (typeof taskId !== "string" || !(taskId in statuses)
      || !Number.isSafeInteger(applied.replayLogicalAttempt) || applied.replayLogicalAttempt! < 1) {
      throw new Error("replay-task control has an invalid task or logical attempt");
    }
    statuses[taskId] = "pending";
    nextLogicalAttempt[taskId] = applied.replayLogicalAttempt!;
    runCycle += 1;
    yield* recordReplay(
      context, input.statusEnabled, input.runId, taskId,
      applied.replayLogicalAttempt!, record.controlId, true,
    );
    armControlWait();
    context.setCustomStatus("running");
  }
}
