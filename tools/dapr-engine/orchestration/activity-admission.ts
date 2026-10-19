import type { ArtifactRefV1, Sha256Digest } from "../contract/v1/index.ts";
import { ArtifactStore } from "../execution/artifacts.ts";
import {
  assertTaskCapabilities,
  prepareTaskRequestWithPredecessors,
  type PrepareTaskRequestOptions,
} from "../execution/request.ts";
import { admitTaskResult } from "../execution/task-admission.ts";
import type { HarnessAdapter, ManifestTask, TaskResult } from "../execution/types.ts";
import { captureWorktree, type WorktreeSnapshot } from "../execution/verify.ts";
import {
  boundTaskExecutionOutcome,
  createTaskCompletionEvidence,
  type TaskExecutionOutcomeV1,
} from "./outcome.ts";
import type { TaskAdmissionResult } from "../execution/task-admission.ts";

export interface TaskActivityAdmissionInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly task: ManifestTask;
  readonly result: TaskResult;
  readonly repoRoot: string;
  readonly baseline: WorktreeSnapshot | null;
  readonly allowNoop: boolean;
  readonly timeoutMs: number;
  /** References must already be durably published and integrity-verified. */
  readonly artifactRefs: readonly ArtifactRefV1[];
}

export interface ExecuteVerifiedTaskActivityInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly request: PrepareTaskRequestOptions;
  readonly harness: HarnessAdapter;
  readonly artifactStore: ArtifactStore;
  readonly predecessorTaskIds: readonly string[];
  readonly allowNoop: boolean;
  readonly publishArtifacts?: (
    admission: Extract<TaskAdmissionResult, { ok: true }>,
  ) => Promise<readonly ArtifactRefV1[]>;
}

function outcomeForAdmission(
  input: Pick<TaskActivityAdmissionInputV1,
    "runId" | "taskId" | "manifestDigest" | "logicalAttempt" | "operationId">,
  admission: TaskAdmissionResult,
  artifactRefs: readonly ArtifactRefV1[],
): TaskExecutionOutcomeV1 {
  if (!admission.ok) {
    return boundTaskExecutionOutcome({
      status: "failed",
      retryable: admission.retryable,
      failureCode: admission.failureCode,
      reason: admission.reason,
      gates: admission.gates,
    });
  }
  return boundTaskExecutionOutcome({
    status: "complete",
    evidence: createTaskCompletionEvidence({
      runId: input.runId,
      taskId: input.taskId,
      manifestDigest: input.manifestDigest,
      logicalAttempt: input.logicalAttempt,
      operationId: input.operationId,
      outputFiles: admission.outputFiles,
      handoffDigest: admission.handoffDigest,
      artifactRefs,
      validationCommands: admission.validationCommands,
    }),
  });
}

/** Bridges the Dapr-independent execution gates to the workflow activity result. */
export async function admitTaskActivityResult(
  input: TaskActivityAdmissionInputV1,
): Promise<TaskExecutionOutcomeV1> {
  if (input.task.id !== input.taskId) throw new Error("Activity task identity does not match the manifest task.");
  const admission = await admitTaskResult({
    task: input.task,
    result: input.result,
    repoRoot: input.repoRoot,
    baseline: input.baseline,
    allowNoop: input.allowNoop,
    timeoutMs: input.timeoutMs,
  });
  return outcomeForAdmission(input, admission, input.artifactRefs);
}

/** Executes one harness attempt and admits it only after output, handoff, and validation gates pass. */
export async function executeVerifiedTaskActivity(
  input: ExecuteVerifiedTaskActivityInputV1,
): Promise<TaskExecutionOutcomeV1> {
  const task = input.request.task;
  if (task.id !== input.taskId
    || input.request.runId !== input.runId
    || input.request.attempt !== input.logicalAttempt) {
    throw new Error("Task activity identity does not match its prepared request.");
  }
  if (task.produces && !input.publishArtifacts) {
    throw new Error(`Task '${task.id}' declares artifact output '${task.produces}' but has no durable artifact publisher.`);
  }
  assertTaskCapabilities(task, input.harness);
  const request = prepareTaskRequestWithPredecessors({
    ...input.request,
    artifactStore: input.artifactStore,
    predecessorTaskIds: input.predecessorTaskIds,
  });
  const baseline = await captureWorktree(request.repoRoot);
  const result = await input.harness.invoke(request);
  const admission = await admitTaskResult({
    task,
    result,
    repoRoot: request.repoRoot,
    baseline,
    allowNoop: input.allowNoop,
    timeoutMs: request.budget.timeoutMs,
  });
  if (!admission.ok) return outcomeForAdmission(input, admission, []);
  const artifactRefs = input.publishArtifacts ? await input.publishArtifacts(admission) : [];
  return outcomeForAdmission(input, admission, artifactRefs);
}
