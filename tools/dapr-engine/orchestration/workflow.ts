import { createHash } from "node:crypto";
import type { Task, WorkflowContext } from "@dapr/dapr";
import type { Sha256Digest, TaskStatusV1 } from "../contract/v1/index.ts";
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
export type { TaskExecutionOutcomeV1 } from "./outcome.ts";

export interface RunWorkflowInputV1 {
  readonly runId: string;
  readonly submission: AcceptedRunSubmissionV1;
  /** Required: true only when the host registers durable control activities. */
  readonly controlsEnabled: boolean;
}

export interface TaskAttemptWorkflowInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly allowNoop: boolean;
  readonly initialLogicalAttempt?: number;
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
  readonly status: "complete" | "failed" | "cancelled";
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
export const GET_RUN_CONTROL_ACTIVITY_NAME = "getRunControl";
export const APPLY_RUN_CONTROL_ACTIVITY_NAME = "applyRunControl";

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
  return typeof controlId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(controlId);
}

function validateTaskAttemptInput(input: TaskAttemptWorkflowInputV1): void {
  if (!input.runId || !input.taskId
    || !/^sha256:[0-9a-f]{64}$/.test(input.manifestDigest)
    || !Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0
    || !Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0
    || typeof input.allowNoop !== "boolean"
    || (input.initialLogicalAttempt !== undefined &&
      (!Number.isSafeInteger(input.initialLogicalAttempt) || input.initialLogicalAttempt < 1))) {
    throw new Error("Invalid task attempt workflow input");
  }
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
      return { status: "failed", retryable: false, failureCode: "activity-failed" };
    }
    if (!isTaskActivityOutcome(activityOutcome, activityInput)) throw new Error("executeTask returned an invalid outcome");
    let outcome: TaskActivityOutcomeV1 = activityOutcome;
    while (outcome.status === "waiting") {
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
        taskWorkflowInstanceId: taskAttemptWorkflowIdForAttempt(
          input.runId,
          input.taskId,
          input.initialLogicalAttempt ?? 1,
        ),
      };
      let resumedOutcome: unknown;
      try {
        resumedOutcome = yield context.callActivity(RESUME_TASK_ACTIVITY_NAME, resumeInput);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { status: "failed", retryable: false, failureCode: "resume-activity-failed" };
      }
      if (!isTaskActivityOutcome(resumedOutcome, resumeInput)) throw new Error("resumeTask returned an invalid outcome");
      outcome = resumedOutcome;
    }
    if (outcome.status !== "failed" || !outcome.retryable || retry === input.maxRetries) return outcome;

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

/** Runs manifest-ordered task waves and only dispatches dependency-ready work. */
export async function* runOrchestrationWorkflow(
  context: WorkflowContext,
  input: RunWorkflowInputV1,
): AsyncGenerator<Task<unknown>, RunWorkflowResultV1, unknown> {
  if (!input.runId) throw new Error("runId is required");
  if (typeof input.controlsEnabled !== "boolean") throw new Error("controlsEnabled must be explicit");
  const plan = buildOrchestrationPlan(input.submission);
  const statuses: Record<string, TaskStatusV1> = Object.fromEntries(
    plan.tasks.map(({ taskId }) => [taskId, "pending"]),
  );
  const nextLogicalAttempt: Record<string, number> = Object.fromEntries(
    plan.tasks.map(({ taskId }) => [taskId, 1]),
  );

  let pendingControlEvent: Task<unknown> | undefined = input.controlsEnabled
    ? context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME)
    : undefined;
  while (true) {
    while (Object.values(statuses).some((status) => status === "pending")) {
      const wave = nextDispatchWave(plan.tasks, statuses, plan.maxConcurrency);
      if (wave.length === 0) {
        if (Object.values(statuses).some((status) => status === "failed")) break;
        throw new Error("No task is ready while pending tasks remain");
      }

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
          },
          taskAttemptWorkflowIdForAttempt(input.runId, taskId, logicalAttempt),
        );
      });
      const waveTask = context.whenAll(children);
      let outcomes: TaskExecutionOutcomeV1[];
      const boundaryControls: RunControlRecordSummaryV1[] = [];

      if (pendingControlEvent) {
        const winner = yield context.whenAny([waveTask, pendingControlEvent]);
        if (!winner || typeof winner !== "object" || !("getResult" in winner)) {
          throw new Error("Run workflow whenAny returned an invalid task");
        }
        const completedTask = winner as Task<unknown>;
        if (completedTask === pendingControlEvent) {
          const wake = completedTask.getResult();
          if (!isRunControlWakeEvent(wake)) {
            throw new Error("run-control event must contain a UUID controlId");
          }
          const record: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
            controlId: wake.controlId,
          });
          if (!isRunControlRecord(record, input.runId) || record.controlId !== wake.controlId) {
            throw new Error("getRunControl returned a mismatched control record");
          }
          if (record.state === "applied" && record.action !== "cancel") {
            pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
            outcomes = (yield waveTask) as TaskExecutionOutcomeV1[];
          } else {
            pendingControlEvent = undefined;

            if (record.action === "cancel") {
              const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                controlId: record.controlId,
              });
              if (!isAppliedRunControl(applied) || applied.controlId !== record.controlId) {
                throw new Error("applyRunControl returned an invalid cancellation result");
              }
              cancelUnfinishedTasks(statuses);
              return { status: "cancelled", taskStatuses: statuses };
            }

            if (record.action === "pause" || record.action === "stop") {
              const applied: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                controlId: record.controlId,
              });
              if (!isAppliedRunControl(applied) || applied.controlId !== record.controlId) {
                throw new Error("applyRunControl returned an invalid pause/stop result");
              }
              context.setCustomStatus("paused");
              while (true) {
                const resumeWake: unknown = yield context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
                if (!isRunControlWakeEvent(resumeWake)) {
                  throw new Error("run-control event must contain a UUID controlId");
                }
                const resumeRecord: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
                  controlId: resumeWake.controlId,
                });
                if (!isRunControlRecord(resumeRecord, input.runId)
                  || resumeRecord.controlId !== resumeWake.controlId) {
                  throw new Error("getRunControl returned a mismatched control record");
                }
                if (resumeRecord.state === "applied") continue;
                const resumeResult: unknown = yield context.callActivity(APPLY_RUN_CONTROL_ACTIVITY_NAME, {
                  controlId: resumeRecord.controlId,
                });
                if (!isAppliedRunControl(resumeResult) || resumeResult.controlId !== resumeRecord.controlId) {
                  throw new Error("applyRunControl returned an invalid result");
                }
                if (resumeRecord.action === "resume") break;
                if (resumeRecord.action === "cancel") {
                  cancelUnfinishedTasks(statuses);
                  return { status: "cancelled", taskStatuses: statuses };
                }
                if (resumeRecord.action === "replay-task") boundaryControls.push(resumeRecord);
                else throw new Error("Only resume, cancel, or replay-task is valid while paused");
              }
              context.setCustomStatus("running");
              outcomes = (yield waveTask) as TaskExecutionOutcomeV1[];
            } else {
              boundaryControls.push(record);
              outcomes = (yield waveTask) as TaskExecutionOutcomeV1[];
            }
          }
        } else if (completedTask === waveTask) {
          outcomes = completedTask.getResult() as TaskExecutionOutcomeV1[];
        } else {
          throw new Error("Run workflow whenAny returned an unrelated task");
        }
      } else {
        outcomes = (yield waveTask) as TaskExecutionOutcomeV1[];
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
        }
        pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
      } else if (input.controlsEnabled && !pendingControlEvent) {
        pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
      } else if (outcomes.some((outcome) => outcome.status === "failed")) {
        break;
      }
    }

    const failed = Object.values(statuses).some((status) => status === "failed");
    if (!input.controlsEnabled) {
      return { status: failed ? "failed" : "complete", taskStatuses: statuses };
    }
    context.setCustomStatus(failed ? "failed" : "complete");
    const terminalControlEvent = pendingControlEvent ?? context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
    const wake: unknown = yield terminalControlEvent;
    if (!isRunControlWakeEvent(wake)) throw new Error("run-control event must contain a UUID controlId");
    const record: unknown = yield context.callActivity(GET_RUN_CONTROL_ACTIVITY_NAME, {
      controlId: wake.controlId,
    });
    if (!isRunControlRecord(record, input.runId) || record.controlId !== wake.controlId
      || record.action !== "replay-task") {
      throw new Error("Only a valid replay-task control can reopen a terminal run");
    }
    if (record.state === "applied") {
      pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
      continue;
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
    pendingControlEvent = context.waitForExternalEvent(RUN_CONTROL_EVENT_NAME);
    context.setCustomStatus("running");
  }
}
