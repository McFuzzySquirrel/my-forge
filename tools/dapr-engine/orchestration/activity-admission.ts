import type { ArtifactRefV1, Sha256Digest } from "../contract/v1/index.ts";
import { ArtifactStore } from "../execution/artifacts.ts";
import {
  assertTaskCapabilities,
  prepareTaskRequestWithPredecessors,
  type PrepareTaskRequestOptions,
} from "../execution/request.ts";
import {
  parseHarnessRunnerResult,
  type HarnessRunner,
  type HarnessRunnerRequestV1,
} from "../execution/runner-contract.ts";
import { applyWorkspaceDelta, DEFAULT_MAX_WORKSPACE_DELTA_BYTES } from "../execution/workspace-diff.ts";
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
  readonly hostRunner?: HarnessRunner;
  readonly repositoryId?: string;
  readonly baseRevision?: string;
  readonly maxWorkspaceDeltaBytes?: number;
  readonly artifactStore: ArtifactStore;
  readonly predecessorTaskIds: readonly string[];
  readonly allowNoop: boolean;
  /** Credential-free environment for validation commands (never the worker env). */
  readonly validationEnvironment?: Readonly<Record<string, string>>;
  readonly publishArtifacts?: (
    admission: Extract<TaskAdmissionResult, { ok: true }>,
  ) => Promise<readonly ArtifactRefV1[]>;
  /**
   * Receives validation evidence produced by a host runner so the execution
   * host can publish it with the checkpoint instead of re-running the commands
   * in a workspace that does not contain the harness's installed dependencies.
   */
  readonly onValidation?: (validation: {
    readonly ok: boolean;
    readonly reason?: string;
    readonly record: Readonly<Record<string, unknown>>;
  }) => void | Promise<void>;
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
  let result: TaskResult;
  let hostValidation: {
    readonly ok: boolean;
    readonly reason?: string;
    readonly record: Readonly<Record<string, unknown>>;
  } | undefined;
  if (input.hostRunner) {
    if (!input.repositoryId || !input.baseRevision) {
      throw new Error("Host-runner execution requires a registered repository ID and accepted base revision.");
    }
    const runnerRequest: HarnessRunnerRequestV1 = {
      schemaVersion: 1,
      identity: {
        runId: input.runId,
        taskId: input.taskId,
        manifestDigest: input.manifestDigest,
        logicalAttempt: input.logicalAttempt,
        operationId: input.operationId,
      },
      repositoryId: input.repositoryId,
      baseRevision: input.baseRevision,
      harness: input.harness.name,
      agent: request.agent,
      task: request.task,
      ...(request.effectiveModel ? { effectiveModel: request.effectiveModel } : {}),
      contextBlock: request.contextBlock,
      requiredCapabilities: request.requiredCapabilities,
      timeoutMs: request.budget.timeoutMs,
      instructions: request.instructions,
      ...(request.logHarnessActivity ? { logHarnessActivity: true } : {}),
    };
    const remote = parseHarnessRunnerResult(
      runnerRequest,
      await input.hostRunner.run(runnerRequest, request.signal),
      input.maxWorkspaceDeltaBytes ?? DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
    );
    await applyWorkspaceDelta(request.repoRoot, remote.workspaceDelta, {
      ...(request.signal ? { signal: request.signal } : {}),
      maxBytes: input.maxWorkspaceDeltaBytes ?? DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
    });
    result = remote.result;
    hostValidation = remote.validation
      ? {
          ok: remote.validation.ok,
          ...(remote.validation.reason ? { reason: remote.validation.reason } : {}),
          record: { taskId: task.id, results: remote.validation.results },
        }
      : undefined;
  } else {
    result = await input.harness.invoke(request);
  }
  const admission = await admitTaskResult({
    task,
    result,
    repoRoot: request.repoRoot,
    baseline,
    allowNoop: input.allowNoop,
    timeoutMs: request.budget.timeoutMs,
    ...(input.validationEnvironment ? { validationEnvironment: input.validationEnvironment } : {}),
    ...(request.isolation?.processIdentity ? { validationProcessIdentity: request.isolation.processIdentity } : {}),
    ...(input.hostRunner ? { installValidationDependencies: false } : { installValidationDependencies: true }),
    ...(hostValidation ? { validation: hostValidation } : {}),
  });
  if (!admission.ok) return outcomeForAdmission(input, admission, []);
  const validationEvidence = hostValidation ?? {
    ok: true,
    record: admission.validationRecord,
  };
  await input.onValidation?.(validationEvidence);
  const artifactRefs = input.publishArtifacts ? await input.publishArtifacts(admission) : [];
  return outcomeForAdmission(input, admission, artifactRefs);
}
