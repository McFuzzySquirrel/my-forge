import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkflowRuntime } from "@dapr/dapr";
import {
  sha256Digest,
  type ApprovalBindingV1,
  type ApprovalContextV1,
  type ArtifactRefV1,
  type OperationKeyV1,
  type OperationReceiptV1,
  type Sha256Digest,
  type TaskCheckpointV1,
} from "../contract/v1/index.ts";
import { ArtifactStore } from "../execution/artifacts.ts";
import { runCommand } from "../execution/harness/run.ts";
import {
  allocateTaskProcessIdentity,
  buildHarnessEnvironment,
  chownTaskTree,
  createHarnessHome,
  quarantineTaskProcessIdentity,
  releaseTaskProcessIdentity,
} from "../execution/isolation.ts";
import { superviseExecution, type ExecutionOwnershipStore } from "../execution/process-lifecycle.ts";
import type { HarnessRunner } from "../execution/runner-contract.ts";
import { TASK_EXECUTION_DIR } from "../execution/task-execution.ts";
import type { AgentDescriptor, HarnessAdapter, ManifestTask, ProcessIdentityV1 } from "../execution/types.ts";
import { captureWorkspaceCheckpoint, type WorkspaceCheckpointPublisher } from "../execution/workspace-reconstruction.ts";
import type { ArtifactResolveResult } from "../storage/files/artifact-checkpoint-store.ts";
import { reconcileIntegrationReceipt } from "../storage/git-effect-reconciliation.ts";
import type { ReceiptStoreResult } from "../storage/postgres/operation-receipts.ts";
import type {
  LeaseResult,
  RepositoryIntegrationReconciliation,
  RepositoryIntegrationRequest,
  RepositoryIntegrationResult,
  RepositoryIntegrationScope,
} from "../storage/postgres/repository-integration.ts";
import { RepositoryIntegrationAmbiguousError } from "../storage/postgres/repository-integration.ts";
import type { RunLifecycleEventPageV1, TaskStatusResponseV1 } from "../contract/v1/status.ts";
import { executeVerifiedTaskActivity } from "./activity-admission.ts";
import { createResumeTaskActivity, type ApprovalControlStore, type ApprovalWakeIdentityV1 } from "./approval-control.ts";
import { boundTaskExecutionOutcome, createTaskCompletionEvidence, type TaskExecutionOutcomeV1 } from "./outcome.ts";
import { buildOrchestrationPlan, type AcceptedRunSubmissionV1 } from "./planner.ts";
import {
  EXECUTE_TASK_ACTIVITY_NAME,
  RESUME_TASK_ACTIVITY_NAME,
  taskOperationId,
  type ExecuteTaskActivityInputV1,
  type ResumeTaskActivityInputV1,
  type TaskActivityOutcomeV1,
} from "./workflow.ts";

const execFileAsync = promisify(execFile);
const GIT_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const EVIDENCE_TAIL_BYTES = 4_000;

type FailedOutcome = Extract<TaskExecutionOutcomeV1, { status: "failed" }>;

/**
 * One accepted run as the host executes it. The task definitions come from the
 * immutable manifest snapshot; the harness and credential resolver are bound
 * by the operator for this run only.
 */
export interface ExecutionHostRunV1 {
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly tasks: ReadonlyMap<string, ManifestTask>;
  readonly prerequisites: ReadonlyMap<string, readonly string[]>;
  readonly allowNoop: boolean;
  readonly maxRetries: number;
  readonly agentFor: (task: ManifestTask) => AgentDescriptor;
  readonly harness: HarnessAdapter;
  readonly hostRunner?: HarnessRunner;
  /** Resolves the scoped credential environment for one attempt; never persisted. */
  readonly credentials?: () => Promise<Readonly<Record<string, string>>>;
  readonly timeoutMs?: number;
}

export interface ExecutionHostRunBindingV1 {
  readonly agentFor: ExecutionHostRunV1["agentFor"];
  readonly harness: HarnessAdapter;
  readonly hostRunner?: HarnessRunner;
  readonly credentials?: ExecutionHostRunV1["credentials"];
  readonly timeoutMs?: number;
}

/** Derives the host view of a run from its accepted submission snapshot. */
export function executionHostRunFromSubmission(
  runId: string,
  submission: AcceptedRunSubmissionV1,
  binding: ExecutionHostRunBindingV1,
): ExecutionHostRunV1 {
  const plan = buildOrchestrationPlan(submission);
  const tasks = new Map<string, ManifestTask>();
  for (const phase of submission.manifestSnapshot.phases) {
    for (const task of phase.tasks as readonly unknown[]) {
      const candidate = task as Partial<ManifestTask>;
      if (typeof candidate.id !== "string" || typeof candidate.title !== "string"
        || !Array.isArray(candidate.expectedOutputs) || !Array.isArray(candidate.validationCommands)) {
        throw new Error(`Manifest snapshot task '${String(candidate.id)}' is not an executable manifest task`);
      }
      tasks.set(candidate.id, structuredClone(candidate as ManifestTask));
    }
  }
  return {
    runId,
    manifestDigest: submission.manifestDigest,
    repositoryId: submission.repositoryId,
    targetRef: submission.targetRef,
    tasks,
    prerequisites: new Map(plan.tasks.map((task) => [task.taskId, task.prerequisites])),
    allowNoop: plan.allowNoop,
    maxRetries: plan.maxRetries,
    ...binding,
  };
}

export interface ExecutionHostReceiptStore {
  claim(key: OperationKeyV1): Promise<ReceiptStoreResult>;
  get(key: OperationKeyV1): Promise<OperationReceiptV1 | undefined>;
  transition(
    key: OperationKeyV1,
    expectedVersion: number,
    to: OperationReceiptV1["state"],
    options?: { readonly effectDigest?: Sha256Digest; readonly diagnosticRef?: string },
  ): Promise<ReceiptStoreResult>;
}

export interface ExecutionHostIntegrationAuthority {
  acquire(repositoryId: string, targetRef: string, runId: string, ttlMs: number): Promise<LeaseResult>;
  integrate(request: RepositoryIntegrationRequest): Promise<RepositoryIntegrationResult>;
  reconcile(scope: RepositoryIntegrationScope): Promise<RepositoryIntegrationReconciliation>;
}

export interface ExecutionHostCheckpointStore extends WorkspaceCheckpointPublisher {
  resolveArtifact(ref: ArtifactRefV1): Promise<ArtifactResolveResult>;
}

export interface ExecutionHostDependenciesV1 {
  readonly runs: (runId: string) => ExecutionHostRunV1 | undefined;
  readonly receipts: ExecutionHostReceiptStore;
  readonly executions: ExecutionOwnershipStore;
  readonly integration: ExecutionHostIntegrationAuthority;
  readonly checkpoints: ExecutionHostCheckpointStore;
  readonly status: {
    getTaskStatus(runId: string, taskId: string): Promise<TaskStatusResponseV1 | undefined>;
    listEvents(runId: string, afterSequence?: number, limit?: number): Promise<RunLifecycleEventPageV1>;
    /** When present, attempts of a cancelling or cancelled run neither start nor integrate. */
    getRunStatus?(runId: string): Promise<{ readonly status: string } | undefined>;
  };
  readonly controls: ApprovalControlStore;
  /** Absolute path of the integration-owned target repository. */
  readonly repositoryRoot: (repositoryId: string) => string | undefined;
  /** Absolute scratch root for workspaces, harness homes, and the outcome journal; outside the host home. */
  readonly scratchRoot: string;
  readonly taskUidIsolation?: boolean;
  readonly taskScratchRoot?: string;
  readonly workerId: string;
  readonly budgetMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTtlMs: number;
  readonly leaseTtlMs?: number;
  /** Source of allowlisted pass-through variables for harness processes. */
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  /** Receives non-secret audit events (one JSON object per call). */
  readonly audit?: (event: Readonly<Record<string, unknown>>) => void;
}

/** Host-local state needed to finish an attempt after its harness effect. */
interface PreparedEffect {
  readonly checkpointDigest: Sha256Digest;
  readonly resultCommit: string;
  readonly baseRevision: string;
  readonly validationRef: ArtifactRefV1;
  readonly bundleRef: ArtifactRefV1;
  readonly outputFiles: readonly string[];
  readonly handoffDigest: Sha256Digest;
  readonly validationCommands: readonly string[];
}

interface JournalEntry {
  readonly outcome?: TaskActivityOutcomeV1;
  /** Written before an integration so a redelivered activity can reconcile it. */
  readonly pending?: { readonly outcome: TaskExecutionOutcomeV1; readonly repositoryId: string; readonly targetRef: string };
  /** Present for an approval wait: the verified, not yet integrated effect. */
  readonly approval?: PreparedEffect & { readonly evidenceDigests: readonly Sha256Digest[] };
  /** Present for a human-review wait: the published review evidence, no harness effect. */
  readonly review?: { readonly evidenceRef: ArtifactRefV1; readonly evidenceDigests: readonly Sha256Digest[] };
  readonly failureReason?: string;
}

function gitEnvironment(home: string, safeDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "MyForge host",
    GIT_AUTHOR_EMAIL: "myforge-host@example.invalid",
    GIT_COMMITTER_NAME: "MyForge host",
    GIT_COMMITTER_EMAIL: "myforge-host@example.invalid",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: safeDirectory,
  };
}

function tail(text: string): string {
  return text.length > EVIDENCE_TAIL_BYTES ? `[truncated]\n${text.slice(-EVIDENCE_TAIL_BYTES)}` : text;
}

/**
 * Composes the Dapr-independent execution layers into the `executeTask` and
 * `resumeTask` workflow activities: an isolated per-operation Git workspace, a
 * supervised and isolated harness process, P4-02 admission gates, checkpoint
 * capture with published validation evidence, and fenced integration recorded
 * against a durable operation receipt. Tasks with `approvalRequired` wait with
 * their verified checkpoint bound into the approval evidence and integrate only
 * after an authorized approval resumes them.
 */
const RUN_CANCELLED = {
  status: "failed",
  retryable: false,
  failureCode: "run-cancelled",
  reason: "The run was cancelled",
} as const;

export class ExecutionHost {
  private readonly integrationQueues = new Map<string, Promise<unknown>>();
  private readonly gitHome: string;

  constructor(private readonly dependencies: ExecutionHostDependenciesV1) {
    if (!isAbsolute(dependencies.scratchRoot)) throw new Error("Execution host scratch root must be absolute");
    this.gitHome = join(dependencies.scratchRoot, "git-home");
  }

  register(runtime: WorkflowRuntime): WorkflowRuntime {
    return runtime
      .registerActivityWithName(EXECUTE_TASK_ACTIVITY_NAME, (_context: unknown, input: ExecuteTaskActivityInputV1) =>
        this.executeTask(input))
      .registerActivityWithName(RESUME_TASK_ACTIVITY_NAME, this.resumeTaskActivity());
  }

  resumeTaskActivity(): (context: unknown, input: ResumeTaskActivityInputV1) => Promise<TaskActivityOutcomeV1> {
    return createResumeTaskActivity({
      store: this.dependencies.controls,
      currentContext: (identity) => this.approvalContextFor(identity),
      resume: (input, binding) => this.resumeTask(input, binding),
    });
  }

  /** Operator-facing approval context for the task's current waiting attempt. */
  async approvalContext(runId: string, taskId: string, resumingControlId?: string): Promise<ApprovalContextV1 | undefined> {
    const run = this.dependencies.runs(runId);
    const status = await this.dependencies.status.getTaskStatus(runId, taskId);
    if (!run || !status?.task.logicalAttempt) return undefined;
    const logicalAttempt = status.task.logicalAttempt;
    const wait = await this.waitState(runId, taskId, logicalAttempt, resumingControlId);
    if (!wait) return undefined;
    const journal = await this.readJournal(taskOperationId(runId, taskId, logicalAttempt));
    return {
      runId,
      manifestDigest: run.manifestDigest,
      taskId,
      logicalAttempt,
      taskWorkflowInstanceId: wait.taskWorkflowInstanceId,
      // The workflow records `attempt.resumed` before the resume activity validates
      // the wake, so that one control still observes the attempt as waiting.
      taskStatus: wait.resumedBy ? "waiting-for-approval" : status.task.status,
      evidenceDigests: journal?.approval?.evidenceDigests ?? journal?.review?.evidenceDigests ?? [],
    };
  }

  /** The workflow records which task-attempt instance is waiting; replayed tasks start new instances. */
  private async waitState(
    runId: string,
    taskId: string,
    logicalAttempt: number,
    resumingControlId: string | undefined,
  ): Promise<{ readonly taskWorkflowInstanceId: string; readonly resumedBy: boolean } | undefined> {
    let cursor = 0;
    let instance: string | undefined;
    let last: RunLifecycleEventPageV1["events"][number] | undefined;
    for (;;) {
      const page = await this.dependencies.status.listEvents(runId, cursor, 1000);
      for (const event of page.events) {
        if (event.taskId !== taskId || event.logicalAttempt !== logicalAttempt) continue;
        last = event;
        const candidate = event.detail?.taskWorkflowInstanceId;
        if (event.eventType === "attempt.waiting-for-approval" && typeof candidate === "string") instance = candidate;
      }
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    if (!instance || !last) return undefined;
    const resumedBy = resumingControlId !== undefined && last.eventType === "attempt.resumed"
      && last.eventKey.endsWith(`:resumed:${resumingControlId}`);
    return { taskWorkflowInstanceId: instance, resumedBy };
  }

  async executeTask(input: ExecuteTaskActivityInputV1): Promise<TaskActivityOutcomeV1> {
    const run = this.requireRun(input);
    const task = run.tasks.get(input.taskId);
    if (!task) throw new Error(`Run '${input.runId}' has no task '${input.taskId}'`);
    const key = operationKey(input);
    const journaled = await this.readJournal(input.operationId);
    if (journaled?.outcome) return journaled.outcome;

    const claimed = await this.dependencies.receipts.claim(key);
    if (!claimed.ok) throw new Error(`Could not claim operation receipt: ${claimed.code}`);
    if (claimed.receipt.state !== "claimed") return this.recover(run, key, claimed.receipt, journaled);
    let receipt = await this.transition(key, claimed.receipt, "executing");
    if (await this.runCancelled(input.runId)) return this.finishFailed(key, receipt, RUN_CANCELLED);
    if (task.contract?.kind === "human-review") return this.awaitReview(run, task, key, receipt);

    const workspace = await this.prepareWorkspace(run, input.operationId);
    const processIdentity = this.dependencies.taskUidIsolation ? allocateTaskProcessIdentity() : undefined;
    try {
      if (processIdentity) await chownTaskTree(workspace.path, processIdentity);
      this.audit({ event: "attempt.workspace", ...key, baseRevision: workspace.baseRevision });
      const previousFailure = input.logicalAttempt > 1
        ? (await this.readJournal(taskOperationId(input.runId, input.taskId, input.logicalAttempt - 1)))?.failureReason
        : undefined;
      const supervised = await superviseExecution({
        store: this.dependencies.executions,
        key,
        workerId: this.dependencies.workerId,
        budgetMs: this.dependencies.budgetMs,
        heartbeatIntervalMs: this.dependencies.heartbeatIntervalMs,
        heartbeatTtlMs: this.dependencies.heartbeatTtlMs,
        run: async (context) => {
          let home: Awaited<ReturnType<typeof createHarnessHome>> | undefined;
          try {
            home = await createHarnessHome(
              join(this.dependencies.taskUidIsolation ? this.requireTaskScratchRoot() : this.dependencies.scratchRoot, "homes"),
              processIdentity ? { processIdentity } : {},
            );
            const credentials = run.hostRunner ? {} : run.credentials ? await run.credentials() : {};
            const environment = buildHarnessEnvironment({
              home: home.home,
              inherited: this.dependencies.inheritedEnvironment ?? process.env,
              credentials,
            });
            return await executeVerifiedTaskActivity({
              runId: input.runId,
              taskId: input.taskId,
              manifestDigest: input.manifestDigest,
              logicalAttempt: input.logicalAttempt,
              operationId: input.operationId,
              ...(run.hostRunner ? {
                hostRunner: run.hostRunner,
                repositoryId: run.repositoryId,
                baseRevision: workspace.baseRevision,
              } : {}),
              request: {
                agent: run.agentFor(task),
                task,
                repoRoot: workspace.path,
                runId: input.runId,
                attempt: input.logicalAttempt,
                maxRetries: run.maxRetries,
                timeoutMs: Math.max(1, Math.min(context.remainingMs, run.timeoutMs ?? context.remainingMs)),
                signal: context.signal,
                ...(previousFailure ? { previousFailure } : {}),
                isolation: {
                  environment,
                  ...(processIdentity ? { processIdentity } : {}),
                  onProcessSettled: (cleanup) => {
                    if (processIdentity && cleanup === "unconfirmed") quarantineTaskProcessIdentity(processIdentity);
                    context.onProcessSettled(cleanup);
                  },
                },
              },
              harness: run.harness,
              artifactStore: new ArtifactStore({ artifactsPath: join(this.dependencies.scratchRoot, "runs", input.runId, "artifacts") }),
              predecessorTaskIds: run.prerequisites.get(input.taskId) ?? [],
              allowNoop: input.allowNoop,
              validationEnvironment: {
                ...buildHarnessEnvironment({
                  home: home.home,
                  inherited: this.dependencies.inheritedEnvironment ?? process.env,
                  credentials: {},
                }),
                MYFORGE_LOGICAL_ATTEMPT: String(input.logicalAttempt),
              },
              ...(processIdentity ? { validationProcessIdentity: processIdentity } : {}),
            });
          } finally {
            if (home) {
              try {
                await rm(home.home, { recursive: true, force: true });
              } catch (error) {
                if (processIdentity) quarantineTaskProcessIdentity(processIdentity);
                throw error;
              }
            }
          }
        },
      });
      if (!supervised.started) throw new Error(`Execution ownership was not granted: ${supervised.code}`);

      let outcome: TaskExecutionOutcomeV1;
      if (supervised.stopReason || supervised.error !== undefined || !supervised.result) {
        outcome = {
          status: "failed",
          // A cancelled attempt must not be retried under a new logical operation.
          retryable: supervised.stopReason !== "cancel",
          failureCode: supervised.stopReason ? `execution-${supervised.stopReason}` : "execution-error",
          reason: supervised.error instanceof Error ? supervised.error.message : supervised.stopReason ?? "no result",
        };
      } else {
        outcome = supervised.result;
      }
      if (outcome.status === "skipped") {
        outcome = { status: "failed", retryable: false, failureCode: "execution-skipped" };
      }
      if (outcome.status !== "complete") {
        return this.finishFailed(key, receipt, outcome);
      }

      const prepared = await this.captureEffect(
        run, task, workspace.path, workspace.baseRevision, outcome, input.logicalAttempt, processIdentity,
      );
      if (!prepared.ok) return this.finishFailed(key, receipt, prepared.outcome);
      this.audit({
        event: "attempt.verified",
        ...key,
        checkpointDigest: prepared.effect.checkpointDigest,
        validationRef: prepared.effect.validationRef,
      });

      if (task.approvalRequired) {
        const evidenceDigests = [outcome.evidence.completionDigest, prepared.effect.checkpointDigest];
        const waitId = `approval-${prepared.effect.checkpointDigest.slice(7, 23)}`;
        receipt = await this.transition(key, receipt, "effect-published", prepared.effect.checkpointDigest);
        await this.writeJournal(input.operationId, { approval: { ...prepared.effect, evidenceDigests } });
        await this.transition(key, receipt, "accepted");
        const waiting: TaskActivityOutcomeV1 = { status: "waiting", waitId };
        await this.writeJournal(input.operationId, { approval: { ...prepared.effect, evidenceDigests }, outcome: waiting });
        this.audit({ event: "attempt.waiting-for-approval", ...key, waitId, evidenceDigests });
        return waiting;
      }
      return await this.integrate(run, task, key, receipt, prepared.effect, { rebase: true });
    } finally {
      try {
        if (processIdentity) {
          try {
            await rm(workspace.path, { recursive: true, force: true });
          } catch (error) {
            quarantineTaskProcessIdentity(processIdentity);
            throw error;
          }
        }
      } finally {
        if (processIdentity) releaseTaskProcessIdentity(processIdentity);
      }
    }
  }

  /**
   * Human-review tasks are never sent to a model. The attempt publishes review
   * evidence binding the task contract to the target head the reviewer sees,
   * then waits for an authorized approval of exactly that evidence.
   */
  private async awaitReview(
    run: ExecutionHostRunV1,
    task: ManifestTask,
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
  ): Promise<TaskActivityOutcomeV1> {
    const head = await this.git(this.targetRoot(run), ["rev-parse", "--verify", `${run.targetRef}^{commit}`]);
    const bytes = new TextEncoder().encode(`${JSON.stringify({
      schemaVersion: 1,
      kind: "human-review",
      runId: run.runId,
      manifestDigest: run.manifestDigest,
      taskId: task.id,
      logicalAttempt: key.logicalAttempt,
      targetRef: run.targetRef,
      targetHead: head,
      contract: task.contract,
    }, null, 2)}\n`);
    const published = await this.dependencies.checkpoints.publishArtifact(bytes, {
      mediaType: "application/json",
      sizeBytes: bytes.byteLength,
      sha256: sha256Digest(bytes),
      retentionClass: "checkpoint-evidence",
    });
    if (!published.ok) throw new Error(`Could not publish review evidence: ${published.code}`);
    const evidenceDigests = [published.ref.sha256 as Sha256Digest];
    const waitId = `review-${published.ref.sha256.slice(7, 23)}`;
    const effectPublished = await this.transition(key, receipt, "effect-published", evidenceDigests[0]);
    await this.writeJournal(key.operationId, { review: { evidenceRef: published.ref, evidenceDigests } });
    await this.transition(key, effectPublished, "accepted");
    const waiting: TaskActivityOutcomeV1 = { status: "waiting", waitId };
    await this.writeJournal(key.operationId, { review: { evidenceRef: published.ref, evidenceDigests }, outcome: waiting });
    this.audit({ event: "attempt.waiting-for-approval", ...key, waitId, evidenceDigests, review: true });
    return waiting;
  }

  /** Completes an approved human review; there is no repository effect to integrate. */
  private async completeReview(
    run: ExecutionHostRunV1,
    input: ResumeTaskActivityInputV1,
    binding: ApprovalBindingV1,
    review: NonNullable<JournalEntry["review"]>,
  ): Promise<TaskActivityOutcomeV1> {
    const evidenceDigest = (digests: readonly string[]) => [...digests].sort().join(",");
    if (evidenceDigest(binding.evidenceDigests) !== evidenceDigest(review.evidenceDigests)) {
      return { status: "failed", retryable: false, failureCode: "approval-evidence-mismatch" };
    }
    const key = operationKey(input);
    const journaled = await this.readJournal(input.operationId);
    if (journaled?.outcome) return journaled.outcome;
    const claimed = await this.dependencies.receipts.claim(key);
    if (!claimed.ok) throw new Error(`Could not claim operation receipt: ${claimed.code}`);
    if (claimed.receipt.state !== "claimed") return this.recover(run, key, claimed.receipt, journaled);
    const receipt = await this.transition(key, claimed.receipt, "executing");
    const evidence = createTaskCompletionEvidence({
      runId: key.runId,
      taskId: key.taskId,
      manifestDigest: run.manifestDigest,
      logicalAttempt: key.logicalAttempt,
      operationId: key.operationId,
      outputFiles: [],
      handoffDigest: review.evidenceDigests[0]!,
      artifactRefs: [review.evidenceRef],
      validationCommands: [],
      harnessEvidence: [`human review approved by ${binding.operatorId}`],
    });
    const complete: TaskExecutionOutcomeV1 = { status: "complete", evidence };
    const published = await this.transition(key, receipt, "effect-published", evidence.completionDigest);
    await this.transition(key, published, "accepted");
    await this.writeJournal(key.operationId, { outcome: complete });
    this.audit({ event: "attempt.reviewed", ...key, operatorId: binding.operatorId, evidenceDigests: review.evidenceDigests });
    return complete;
  }

  private async resumeTask(input: ResumeTaskActivityInputV1, binding: ApprovalBindingV1): Promise<TaskActivityOutcomeV1> {
    const run = this.requireRun(input);
    const task = run.tasks.get(input.taskId);
    if (!task) throw new Error(`Run '${input.runId}' has no task '${input.taskId}'`);
    const executeOperation = taskOperationId(input.runId, input.taskId, input.logicalAttempt);
    const executed = await this.readJournal(executeOperation);
    if (executed?.review) return this.completeReview(run, input, binding, executed.review);
    const approval = executed?.approval;
    if (!approval) throw new Error(`No verified approval effect exists for ${input.taskId} attempt ${input.logicalAttempt}`);
    const evidenceDigest = (digests: readonly string[]) => [...digests].sort().join(",");
    if (evidenceDigest(binding.evidenceDigests) !== evidenceDigest(approval.evidenceDigests)) {
      return { status: "failed", retryable: false, failureCode: "approval-evidence-mismatch" };
    }
    const key = operationKey(input);
    const journaled = await this.readJournal(input.operationId);
    if (journaled?.outcome) return journaled.outcome;
    const claimed = await this.dependencies.receipts.claim(key);
    if (!claimed.ok) throw new Error(`Could not claim operation receipt: ${claimed.code}`);
    if (claimed.receipt.state !== "claimed") return this.recover(run, key, claimed.receipt, journaled);
    const receipt = await this.transition(key, claimed.receipt, "executing");
    this.audit({ event: "attempt.approved", ...key, operatorId: binding.operatorId });
    // An approval binds one verified tree; a moved target requires a new attempt and approval.
    return this.integrate(run, task, key, receipt, approval, { rebase: false });
  }

  private async approvalContextFor(identity: ApprovalWakeIdentityV1): Promise<ApprovalContextV1 | undefined> {
    const context = await this.approvalContext(identity.runId, identity.taskId, identity.controlId);
    return context?.logicalAttempt === identity.logicalAttempt ? context : undefined;
  }

  private requireRun(input: { readonly runId: string; readonly manifestDigest: string }): ExecutionHostRunV1 {
    const run = this.dependencies.runs(input.runId);
    if (!run) throw new Error(`Run '${input.runId}' is not bound to this execution host`);
    if (run.manifestDigest !== input.manifestDigest) throw new Error("Activity manifest digest does not match the bound run");
    return run;
  }

  private async prepareWorkspace(run: ExecutionHostRunV1, operationId: string): Promise<{ path: string; baseRevision: string }> {
    const target = this.targetRoot(run);
    const baseRevision = await this.git(target, ["rev-parse", "--verify", `${run.targetRef}^{commit}`]);
    const workspaceRoot = this.dependencies.taskUidIsolation
      ? this.requireTaskScratchRoot()
      : this.dependencies.scratchRoot;
    const path = join(workspaceRoot, "workspaces", `${operationId}-${randomUUID().slice(0, 8)}`);
    await mkdir(join(workspaceRoot, "workspaces"), { recursive: true, mode: this.dependencies.taskUidIsolation ? 0o711 : 0o700 });
    if (this.dependencies.taskUidIsolation) await chmod(workspaceRoot, 0o711);
    await this.git(this.dependencies.scratchRoot, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", target, path]);
    // The harness must not reach the integration-owned repository through a remote.
    await this.git(path, ["remote", "remove", "origin"]);
    await this.git(path, ["checkout", "--quiet", "--detach", baseRevision]);
    await appendFile(join(path, ".git", "info", "exclude"), `\n/${TASK_EXECUTION_DIR}/\n`);
    return { path, baseRevision };
  }

  private async runValidation(
    task: ManifestTask,
    root: string,
    timeoutMs: number,
    processIdentity: ProcessIdentityV1 | undefined,
    logicalAttempt: number,
  ): Promise<{
    readonly ok: boolean;
    readonly record: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  }> {
    const results: Array<Record<string, unknown>> = [];
    // Validation commands come from the repository: never hand them the
    // worker's environment (API/Dapr tokens, database URL) or harness grants.
    let home: Awaited<ReturnType<typeof createHarnessHome>> | undefined;
    try {
      if (processIdentity) await chownTaskTree(root, processIdentity);
      home = await createHarnessHome(
        join(this.dependencies.taskUidIsolation ? this.requireTaskScratchRoot() : this.dependencies.scratchRoot, "homes"),
        processIdentity ? { processIdentity } : {},
      );
      const env = {
        ...buildHarnessEnvironment({ home: home.home, inherited: this.dependencies.inheritedEnvironment ?? process.env }),
        MYFORGE_LOGICAL_ATTEMPT: String(logicalAttempt),
      };
      for (const command of task.validationCommands) {
        const result = await runCommand(command, [], {
          shell: true, cwd: root, timeoutMs, maxBufferBytes: 10 * 1024 * 1024,
          env, inheritEnvironment: false, reapProcessGroupOnExit: true,
          ...(processIdentity ? { processIdentity } : {}),
        });
        if (processIdentity && result.processCleanup === "unconfirmed") {
          quarantineTaskProcessIdentity(processIdentity);
        }
        results.push({ command, status: result.status, stdout: tail(result.stdout), stderr: tail(result.stderr) });
        if (result.processCleanup === "unconfirmed") {
          return {
            ok: false,
            record: { taskId: task.id, results },
            reason: `validation command process cleanup could not be confirmed: ${command}`,
          };
        }
        if (result.status !== 0) {
          return {
            ok: false,
            record: { taskId: task.id, results },
            reason: `validation command failed (exit ${result.status}): ${command}`,
          };
        }
      }
      return { ok: true, record: { taskId: task.id, results } };
    } finally {
      if (home) {
        try {
          await rm(home.home, { recursive: true, force: true });
        } catch (error) {
          if (processIdentity) quarantineTaskProcessIdentity(processIdentity);
          throw error;
        }
      }
    }
  }

  private requireTaskScratchRoot(): string {
    if (!this.dependencies.taskScratchRoot || !isAbsolute(this.dependencies.taskScratchRoot)) {
      throw new Error("Task UID isolation requires an absolute task scratch root.");
    }
    return this.dependencies.taskScratchRoot;
  }

  private async captureEffect(
    run: ExecutionHostRunV1,
    task: ManifestTask,
    workspacePath: string,
    baseRevision: string,
    outcome: Extract<TaskExecutionOutcomeV1, { status: "complete" }>,
    logicalAttempt: number,
    processIdentity?: ProcessIdentityV1,
    parentCheckpointDigest?: Sha256Digest,
  ): Promise<{ ok: true; effect: PreparedEffect } | { ok: false; outcome: FailedOutcome }> {
    const timeoutMs = Math.max(1, run.timeoutMs ?? this.dependencies.budgetMs);
    const validation = await this.runValidation(task, workspacePath, timeoutMs, processIdentity, logicalAttempt);
    if (!validation.ok) {
      return { ok: false, outcome: { status: "failed", retryable: true, failureCode: "validation-failed", reason: validation.reason } };
    }
    const bytes = new TextEncoder().encode(`${JSON.stringify({
      schemaVersion: 1,
      runId: run.runId,
      baseRevision,
      ...validation.record,
      completionDigest: outcome.evidence.completionDigest,
    }, null, 2)}\n`);
    const published = await this.dependencies.checkpoints.publishArtifact(bytes, {
      mediaType: "application/json",
      sizeBytes: bytes.byteLength,
      sha256: sha256Digest(bytes),
      retentionClass: "checkpoint-evidence",
    });
    if (!published.ok) throw new Error(`Could not publish validation evidence: ${published.code}`);
    const captured = await captureWorkspaceCheckpoint({
      workspacePath,
      baseRevision,
      runId: run.runId,
      manifestDigest: run.manifestDigest,
      publisher: this.dependencies.checkpoints,
      validationEvidence: [published.ref],
      toolchain: [{ name: "Node.js", version: process.version }],
      commitMessage: `${task.id}: ${task.title}\n\nMyForge run ${run.runId}\n`,
      ...(parentCheckpointDigest ? { parentCheckpointDigest } : {}),
    });
    if (!captured.ok) throw new Error(`Checkpoint capture failed: ${captured.code}`);
    return {
      ok: true,
      effect: {
        checkpointDigest: captured.digest,
        resultCommit: captured.resultCommit,
        baseRevision,
        validationRef: published.ref,
        bundleRef: captured.checkpoint.gitObjectBundle,
        outputFiles: outcome.evidence.outputFiles,
        handoffDigest: outcome.evidence.handoffDigest,
        validationCommands: task.validationCommands,
      },
    };
  }

  /**
   * Serializes integration per target branch. A verified effect based on a
   * superseded head is replayed onto the current head in a fresh workspace and
   * revalidated before it may integrate (parallel isolated tasks).
   */
  private integrate(
    run: ExecutionHostRunV1,
    task: ManifestTask,
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
    effect: PreparedEffect,
    options: { readonly rebase: boolean },
  ): Promise<TaskActivityOutcomeV1> {
    const queueKey = `${run.repositoryId}\0${run.targetRef}`;
    const previous = this.integrationQueues.get(queueKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.integrateExclusive(run, task, key, receipt, effect, options));
    this.integrationQueues.set(queueKey, next);
    return next;
  }

  private async integrateExclusive(
    run: ExecutionHostRunV1,
    task: ManifestTask,
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
    initial: PreparedEffect,
    options: { readonly rebase: boolean },
  ): Promise<TaskActivityOutcomeV1> {
    const target = this.targetRoot(run);
    const head = await this.git(target, ["rev-parse", "--verify", `${run.targetRef}^{commit}`]);
    let effect = initial;
    if (head !== initial.baseRevision) {
      if (!options.rebase) {
        return this.finishFailed(key, receipt, {
          status: "failed",
          retryable: true,
          failureCode: "approved-checkpoint-stale",
          reason: "The target branch moved after approval; a new attempt must be verified and approved.",
        });
      }
      const rebased = await this.rebaseEffect(run, task, key, initial, head);
      if (!rebased.ok) return this.finishFailed(key, receipt, rebased.outcome);
      effect = rebased.effect;
    }

    const evidence = createTaskCompletionEvidence({
      runId: key.runId,
      taskId: key.taskId,
      manifestDigest: run.manifestDigest,
      logicalAttempt: key.logicalAttempt,
      operationId: key.operationId,
      outputFiles: effect.outputFiles,
      handoffDigest: effect.handoffDigest,
      artifactRefs: [effect.validationRef, effect.bundleRef],
      validationCommands: effect.validationCommands,
    });
    const complete: TaskExecutionOutcomeV1 = { status: "complete", evidence };
    const bounded = boundTaskExecutionOutcome(complete);
    if (bounded.status !== "complete") return this.finishFailed(key, receipt, bounded as FailedOutcome);
    if (await this.runCancelled(key.runId)) return this.finishFailed(key, receipt, RUN_CANCELLED);
    await this.writeJournal(key.operationId, {
      pending: { outcome: complete, repositoryId: run.repositoryId, targetRef: run.targetRef },
    });
    await this.importBundle(target, effect.bundleRef);
    const lease = await this.dependencies.integration.acquire(
      run.repositoryId,
      run.targetRef,
      run.runId,
      this.dependencies.leaseTtlMs ?? 60_000,
    );
    if (!lease.ok) {
      return this.finishFailed(key, receipt, { status: "failed", retryable: true, failureCode: "integration-lease-held" });
    }
    const request: RepositoryIntegrationRequest = {
      ...key,
      repositoryId: run.repositoryId,
      targetRef: run.targetRef,
      fencingToken: lease.lease.fencingToken,
      expectedHead: head,
      commitSha: effect.resultCommit,
      checkpointDigest: effect.checkpointDigest,
    };
    let result: RepositoryIntegrationResult;
    try {
      result = await this.dependencies.integration.integrate(request);
    } catch (error) {
      if (!(error instanceof RepositoryIntegrationAmbiguousError)) throw error;
      const ambiguous = await this.transition(key, receipt, "ambiguous");
      return this.recover(run, key, ambiguous, await this.readJournal(key.operationId));
    }
    if (!result.ok && result.code === "integration-history-missing") {
      return this.finishFailed(key, receipt, {
        status: "failed",
        retryable: false,
        failureCode: result.code,
        reason: "A commit this run already integrated is missing from the target branch; reconcile Git with the runtime stores before retrying.",
      });
    }
    if (!result.ok) {
      return this.finishFailed(key, receipt, {
        status: "failed",
        retryable: true,
        failureCode: `integration-${result.code}`,
      });
    }
    const published = await this.transition(key, receipt, "effect-published", result.effectDigest);
    await this.transition(key, published, "accepted");
    await this.writeJournal(key.operationId, { outcome: complete });
    this.audit({
      event: "attempt.integrated",
      ...key,
      expectedHead: head,
      commitSha: result.commitSha,
      checkpointDigest: effect.checkpointDigest,
      effectDigest: result.effectDigest,
      rebased: effect !== initial,
    });
    return complete;
  }

  private async rebaseEffect(
    run: ExecutionHostRunV1,
    task: ManifestTask,
    key: OperationKeyV1,
    effect: PreparedEffect,
    head: string,
  ): Promise<{ ok: true; effect: PreparedEffect } | { ok: false; outcome: FailedOutcome }> {
    const workspace = await this.prepareWorkspace(run, `${key.operationId}-rebase`);
    if (workspace.baseRevision !== head) {
      await rm(workspace.path, { recursive: true, force: true });
      return { ok: false, outcome: { status: "failed", retryable: true, failureCode: "integration-target-moved" } };
    }
    await this.importBundle(workspace.path, effect.bundleRef);
    try {
      await this.git(workspace.path, ["cherry-pick", "--no-commit", effect.resultCommit]);
    } catch {
      return {
        ok: false,
        outcome: {
          status: "failed",
          retryable: true,
          failureCode: "integration-conflict",
          reason: `Task changes conflict with the current ${run.targetRef}; retry from the latest head.`,
        },
      };
    }
    const completion = createTaskCompletionEvidence({
      runId: key.runId,
      taskId: key.taskId,
      manifestDigest: run.manifestDigest,
      logicalAttempt: key.logicalAttempt,
      operationId: key.operationId,
      outputFiles: effect.outputFiles,
      handoffDigest: effect.handoffDigest,
      artifactRefs: [],
      validationCommands: effect.validationCommands,
    });
    const processIdentity = this.dependencies.taskUidIsolation ? allocateTaskProcessIdentity() : undefined;
    try {
      const rebased = await this.captureEffect(
        run,
        task,
        workspace.path,
        head,
        { status: "complete", evidence: completion },
        key.logicalAttempt,
        processIdentity,
        effect.checkpointDigest,
      );
      if (rebased.ok) {
        this.audit({ event: "attempt.rebased", ...key, from: effect.baseRevision, onto: head, checkpointDigest: rebased.effect.checkpointDigest });
      }
      return rebased;
    } finally {
      try {
        if (processIdentity) {
          try {
            await chownTaskTree(workspace.path, { uid: 0, gid: 0 });
            await rm(workspace.path, { recursive: true, force: true });
          } catch (error) {
            quarantineTaskProcessIdentity(processIdentity);
            throw error;
          }
        }
      } finally {
        if (processIdentity) releaseTaskProcessIdentity(processIdentity);
      }
    }
  }

  /** Resolves a redelivered operation from its receipt and integration record without repeating effects. */
  private async recover(
    run: ExecutionHostRunV1,
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
    journal: JournalEntry | undefined,
  ): Promise<TaskActivityOutcomeV1> {
    if (journal?.outcome) return journal.outcome;
    if (journal?.pending) {
      const reconciled = await reconcileIntegrationReceipt(this.dependencies.receipts, this.dependencies.integration, {
        ...key,
        repositoryId: journal.pending.repositoryId,
        targetRef: journal.pending.targetRef,
      });
      if (reconciled.resolution === "accepted") {
        await this.writeJournal(key.operationId, { outcome: journal.pending.outcome });
        return journal.pending.outcome;
      }
      if (reconciled.resolution === "failed") {
        return this.journalFailure(key, { status: "failed", retryable: true, failureCode: "integration-not-applied" });
      }
      throw new Error(`Integration for ${key.taskId} attempt ${key.logicalAttempt} is blocked: ${reconciled.blockedReason}`);
    }
    if (receipt.state === "executing") {
      return this.finishFailed(key, receipt, {
        status: "failed",
        retryable: true,
        failureCode: "redelivered-before-outcome",
      });
    }
    throw new Error(`Operation ${key.operationId} is ${receipt.state} without a recoverable outcome (run ${run.runId})`);
  }

  private async runCancelled(runId: string): Promise<boolean> {
    const status = await this.dependencies.status.getRunStatus?.(runId);
    return status?.status === "cancelling" || status?.status === "cancelled";
  }

  private async finishFailed(
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
    outcome: Extract<TaskExecutionOutcomeV1, { status: "failed" }>,
  ): Promise<TaskExecutionOutcomeV1> {
    await this.transition(key, receipt, "failed");
    return this.journalFailure(key, outcome);
  }

  private async journalFailure(
    key: OperationKeyV1,
    unbounded: Extract<TaskExecutionOutcomeV1, { status: "failed" }>,
  ): Promise<TaskExecutionOutcomeV1> {
    const bounded = boundTaskExecutionOutcome(unbounded) as typeof unbounded;
    // A cancelled run must not schedule another attempt, whatever the failure.
    const outcome = bounded.retryable && await this.runCancelled(key.runId)
      ? { ...bounded, retryable: false }
      : bounded;
    await this.writeJournal(key.operationId, {
      outcome,
      failureReason: [outcome.failureCode, outcome.reason].filter(Boolean).join(": "),
    });
    this.audit({ event: "attempt.failed", ...key, failureCode: outcome.failureCode, retryable: outcome.retryable });
    return outcome;
  }

  private async transition(
    key: OperationKeyV1,
    receipt: OperationReceiptV1,
    to: OperationReceiptV1["state"],
    effectDigest?: Sha256Digest,
  ): Promise<OperationReceiptV1> {
    const result = await this.dependencies.receipts.transition(key, receipt.recordVersion, to, effectDigest ? { effectDigest } : {});
    if (!result.ok) throw new Error(`Receipt ${receipt.state} -> ${to} failed: ${result.code}`);
    return result.receipt;
  }

  private async importBundle(repository: string, ref: ArtifactRefV1): Promise<void> {
    const bundle = await this.dependencies.checkpoints.resolveArtifact(ref);
    if (!bundle.ok) throw new Error(`Checkpoint bundle unavailable: ${bundle.code}`);
    const path = join(this.dependencies.scratchRoot, `${randomUUID()}.bundle`);
    await writeFile(path, bundle.bytes, { mode: 0o600 });
    try {
      await this.git(repository, ["fetch", "--quiet", "--no-tags", path, "refs/heads/checkpoint"]);
    } finally {
      await rm(path, { force: true });
    }
  }

  private targetRoot(run: ExecutionHostRunV1): string {
    const root = this.dependencies.repositoryRoot(run.repositoryId);
    if (!root || !isAbsolute(root)) throw new Error(`Repository '${run.repositoryId}' has no integration root`);
    return root;
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    await mkdir(this.gitHome, { recursive: true, mode: 0o700 });
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      env: gitEnvironment(this.gitHome, cwd),
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (args[0] === "rev-parse" && !GIT_OID.test(text)) throw new Error(`git rev-parse returned an invalid object ID`);
    return text;
  }

  private journalPath(operationId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Invalid operation identity");
    return resolve(this.dependencies.scratchRoot, "journal", `${operationId}.json`);
  }

  private async readJournal(operationId: string): Promise<JournalEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.journalPath(operationId), "utf8")) as JournalEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeJournal(operationId: string, entry: JournalEntry): Promise<void> {
    const path = this.journalPath(operationId);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private audit(event: Readonly<Record<string, unknown>>): void {
    this.dependencies.audit?.({ at: new Date().toISOString(), ...event });
  }
}

function operationKey(input: ExecuteTaskActivityInputV1): OperationKeyV1 {
  return {
    runId: input.runId,
    taskId: input.taskId,
    logicalAttempt: input.logicalAttempt,
    operationId: input.operationId,
  };
}
