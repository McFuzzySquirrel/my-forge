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
}

export interface TaskAttemptWorkflowInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly allowNoop: boolean;
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
}

export interface TaskWaitRequestV1 {
  readonly status: "waiting";
  readonly waitId: string;
}

export interface TaskControlWakeEventV1 {
  readonly controlId: string;
}

type TaskActivityOutcomeV1 = TaskExecutionOutcomeV1 | TaskWaitRequestV1;

export interface RunWorkflowResultV1 {
  readonly status: "complete" | "failed";
  readonly taskStatuses: Readonly<Record<string, TaskStatusV1>>;
}

const UUID_NAMESPACE = Buffer.from("8bb1c6bb6d754bd49fc10f645ffb8b0c", "hex");

export const RUN_ORCHESTRATION_WORKFLOW_NAME = "runOrchestrationWorkflow";
export const TASK_ATTEMPT_WORKFLOW_NAME = "taskAttemptWorkflow";
export const EXECUTE_TASK_ACTIVITY_NAME = "executeTask";
export const RESUME_TASK_ACTIVITY_NAME = "resumeTask";
export const TASK_CONTROL_EVENT_NAME = "task-control";

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
    || typeof input.allowNoop !== "boolean") {
    throw new Error("Invalid task attempt workflow input");
  }
}

/** One child workflow owns retries; each accepted retry gets a new logical operation. */
export async function* taskAttemptWorkflow(
  context: WorkflowContext,
  input: TaskAttemptWorkflowInputV1,
): AsyncGenerator<Task<unknown>, TaskExecutionOutcomeV1, unknown> {
  validateTaskAttemptInput(input);
  for (let retry = 0; retry <= input.maxRetries; retry += 1) {
    const logicalAttempt = retry + 1;
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
  return `forge-task-${taskOperationId(runId, taskId, 1)}`;
}

/** Runs manifest-ordered task waves and only dispatches dependency-ready work. */
export async function* runOrchestrationWorkflow(
  context: WorkflowContext,
  input: RunWorkflowInputV1,
): AsyncGenerator<Task<unknown>, RunWorkflowResultV1, TaskExecutionOutcomeV1[]> {
  if (!input.runId) throw new Error("runId is required");
  const plan = buildOrchestrationPlan(input.submission);
  const statuses: Record<string, TaskStatusV1> = Object.fromEntries(
    plan.tasks.map(({ taskId }) => [taskId, "pending"]),
  );

  while (Object.values(statuses).some((status) => status === "pending")) {
    const wave = nextDispatchWave(plan.tasks, statuses, plan.maxConcurrency);
    if (wave.length === 0) {
      const failed = Object.values(statuses).some((status) => status === "failed");
      if (failed) return { status: "failed", taskStatuses: statuses };
      throw new Error("No task is ready while pending tasks remain");
    }

    const children = wave.map(({ taskId }) => context.callChildWorkflow<
      TaskAttemptWorkflowInputV1,
      TaskExecutionOutcomeV1
    >(TASK_ATTEMPT_WORKFLOW_NAME, {
      runId: input.runId,
      taskId,
      manifestDigest: input.submission.manifestDigest,
      maxRetries: plan.maxRetries,
      retryDelayMs: plan.retryDelayMs,
      allowNoop: plan.allowNoop,
    }, taskAttemptWorkflowId(input.runId, taskId)));
    const outcomes = yield context.whenAll(children);
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
    if (outcomes.some((outcome) => outcome.status === "failed")) {
      return { status: "failed", taskStatuses: statuses };
    }
  }

  return { status: "complete", taskStatuses: statuses };
}
