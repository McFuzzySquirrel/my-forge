// In-memory reference model of contract v1. It is a conformance subject for the
// P2-05 fixtures, not the durable service: P3 adapters must pass the same
// fixtures against real stores before any durability claim is made.

import { randomUUID } from "node:crypto";
import {
  SCHEMA_VERSION,
  canTransitionReceipt,
  canonicalDigest,
  computeCheckpointDigest,
  validateSubmission,
  verifyArtifactBytes,
  type ArtifactRefV1,
  type CheckpointV1,
  type ControlRecordV1,
  type ControlRejectionCode,
  type ControlRequestV1,
  type ControlState,
  type FencingLeaseV1,
  type OperationKeyV1,
  type OperationReceiptV1,
  type ReceiptState,
  type RunStatusV1,
  type RunSubmissionV1,
  type Sha256Digest,
  type SubmissionRejectionCode,
  type TaskStatusV1,
} from "../../../contract/v1/index.ts";

export class ManualClock {
  private current: number;
  constructor(start = Date.parse("2026-10-13T00:00:00.000Z")) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

// ─── Runs, status, and controls ─────────────────────────────────────────────

export interface Principal {
  readonly operatorId: string;
  readonly role: "operator" | "client";
}

export interface AttemptRecord {
  readonly logicalAttempt: number;
  readonly operationId: string;
  outcome?: "complete" | "failed" | "waiting-for-approval" | "rejected-late";
  evidenceDigests?: readonly Sha256Digest[];
}

interface TaskRecord {
  status: TaskStatusV1;
  attempts: AttemptRecord[];
  approval?: ApprovalBinding;
}

export interface ApprovalBinding {
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly taskId: string;
  readonly evidenceDigests: readonly Sha256Digest[];
  readonly operatorId: string;
}

interface ActiveActivity {
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
  processRunning: boolean;
}

interface RunRecord {
  readonly runId: string;
  readonly submission: RunSubmissionV1;
  readonly manifestDigest: Sha256Digest;
  readonly snapshotDigest: Sha256Digest;
  readonly effectiveTaskIds: readonly string[];
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  status: RunStatusV1;
  revision: number;
  tasks: Map<string, TaskRecord>;
  active?: ActiveActivity;
  pendingBoundaryControl?: string;
  pendingCancelControl?: string;
  diagnostics: string[];
}

export interface RunStatusSnapshot {
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly snapshotDigest: Sha256Digest;
  readonly revision: number;
  readonly observedAt: string;
  readonly status: RunStatusV1;
  readonly effectiveTaskIds: readonly string[];
  readonly tasks: Readonly<Record<string, { readonly status: TaskStatusV1; readonly attempts: readonly AttemptRecord[] }>>;
  readonly processRunning: boolean;
  readonly diagnostics: readonly string[];
}

export type SubmitResult =
  | { readonly ok: true; readonly runId: string; readonly created: boolean }
  | { readonly ok: false; readonly code: SubmissionRejectionCode; readonly detail: string };

export type ControlResult =
  | { readonly ok: true; readonly record: ControlRecordV1 }
  | { readonly ok: false; readonly code: ControlRejectionCode };

export type DispatchResult = { readonly taskId: string; readonly logicalAttempt: number; readonly operationId: string } | null;

export type CompletionResult = { readonly ok: true } | { readonly ok: false; readonly code: "late-result" | "unknown-run" };

export class ReferenceExecutionService {
  private readonly submissions = new Map<string, { runId: string; snapshotDigest: Sha256Digest }>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly controls = new Map<string, ControlRecordV1>();
  private workflowsStarted = 0;

  constructor(private readonly clock = new ManualClock()) {}

  get workflowCount(): number {
    return this.workflowsStarted;
  }

  submit(submission: RunSubmissionV1): SubmitResult {
    const validation = validateSubmission(submission);
    if (!validation.ok) return validation;
    const key = `${submission.repositoryId}\u0000${submission.submissionKey}`;
    const existing = this.submissions.get(key);
    if (existing) {
      return existing.snapshotDigest === validation.snapshotDigest
        ? { ok: true, runId: existing.runId, created: false }
        : { ok: false, code: "submission-conflict", detail: "submissionKey was already used for a different snapshot" };
    }

    const runId = `run_${randomUUID()}`;
    const effective = new Set(validation.effectiveTaskIds);
    const dependencies = new Map<string, readonly string[]>();
    const tasks = new Map<string, TaskRecord>();
    for (const phase of submission.manifestSnapshot.phases) {
      const phasePrerequisites = (phase.dependencies ?? []).flatMap((phaseId) =>
        submission.manifestSnapshot.phases.find((candidate) => candidate.id === phaseId)?.tasks.map((task) => task.id) ?? []);
      for (const task of phase.tasks) {
        if (!effective.has(task.id)) continue;
        dependencies.set(task.id, [...new Set([...(task.dependencies ?? []), ...phasePrerequisites])]);
        tasks.set(task.id, { status: "pending", attempts: [] });
      }
    }
    // Snapshot is persisted (deep-copied) before the run is accepted.
    const stored = structuredClone({ ...submission, selection: { ...submission.selection, effectiveTaskIds: validation.effectiveTaskIds } });
    this.runs.set(runId, {
      runId,
      submission: stored,
      manifestDigest: validation.manifestDigest,
      snapshotDigest: validation.snapshotDigest,
      effectiveTaskIds: validation.effectiveTaskIds,
      dependencies,
      status: "running",
      revision: 1,
      tasks,
      diagnostics: [],
    });
    this.submissions.set(key, { runId, snapshotDigest: validation.snapshotDigest });
    this.workflowsStarted += 1;
    return { ok: true, runId, created: true };
  }

  storedSubmission(runId: string): RunSubmissionV1 | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run.submission) : undefined;
  }

  /** Every persisted application record, for leak and immutability checks. */
  exportRecords(): string {
    return JSON.stringify({
      runs: [...this.runs.values()].map((run) => ({ ...run, dependencies: [...run.dependencies], tasks: [...run.tasks] })),
      controls: [...this.controls.values()],
    });
  }

  status(runId: string): RunStatusSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return structuredClone({
      runId: run.runId,
      manifestDigest: run.manifestDigest,
      snapshotDigest: run.snapshotDigest,
      revision: run.revision,
      observedAt: this.clock.now().toISOString(),
      status: run.status,
      effectiveTaskIds: run.effectiveTaskIds,
      tasks: Object.fromEntries([...run.tasks].map(([id, task]) => [id, { status: task.status, attempts: task.attempts }])),
      processRunning: run.active?.processRunning ?? false,
      diagnostics: run.diagnostics,
    });
  }

  control(request: ControlRequestV1, principal?: Principal): ControlResult {
    if ((request as { schemaVersion: unknown }).schemaVersion !== SCHEMA_VERSION) return { ok: false, code: "unsupported-schema-version" };
    const requestDigest = canonicalDigest({ runId: request.runId, action: request.action, payload: request.payload });
    const existing = this.controls.get(request.controlId);
    if (existing) {
      return existing.requestDigest === requestDigest ? { ok: true, record: existing } : { ok: false, code: "control-conflict" };
    }
    const run = this.runs.get(request.runId);
    if (!run) return { ok: false, code: "unknown-run" };

    // The request is durably recorded before it is evaluated.
    this.saveControl(request, requestDigest, ["requested"]);
    const reject = (code: ControlRejectionCode): ControlResult => {
      const record = this.saveControl(request, requestDigest, ["requested", "rejected"], code);
      return { ok: true, record };
    };
    const accept = (): ControlRecordV1 => {
      this.touch(run);
      return this.saveControl(request, requestDigest, ["requested", "accepted"]);
    };
    const applyNow = (): ControlResult => {
      accept();
      return { ok: true, record: this.advanceControl(request.controlId, "applied") };
    };

    switch (request.action) {
      case "select-tasks":
        return reject("selection-immutable");
      case "pause":
      case "stop": {
        if (run.status !== "running") return reject("invalid-run-state");
        if (run.active) {
          run.status = request.action === "pause" ? "pausing" : "stopping";
          run.pendingBoundaryControl = request.controlId;
          return { ok: true, record: accept() };
        }
        run.status = "paused";
        return applyNow();
      }
      case "resume":
        if (run.status !== "paused") return reject("invalid-run-state");
        run.status = "running";
        return applyNow();
      case "cancel": {
        if (["complete", "failed", "cancelled", "cancelling"].includes(run.status)) return reject("invalid-run-state");
        if (run.active?.processRunning) {
          run.status = "cancelling";
          run.pendingCancelControl = request.controlId;
          return { ok: true, record: accept() };
        }
        this.cancelRemainingTasks(run);
        run.status = "cancelled";
        return applyNow();
      }
      case "replay-task": {
        const taskId = request.payload.taskId;
        if (typeof taskId !== "string" || !run.tasks.has(taskId)) return reject("unknown-task");
        if (run.status === "cancelled" || run.status === "cancelling") return reject("invalid-run-state");
        const task = run.tasks.get(taskId)!;
        if (task.status !== "complete" && task.status !== "failed") return reject("invalid-task-state");
        task.status = "pending";
        delete task.approval;
        if (run.status === "complete" || run.status === "failed") run.status = "running";
        return applyNow();
      }
      case "approve-task": {
        if (!principal || principal.role !== "operator" || principal.operatorId.length === 0) return reject("operator-identity-required");
        const taskId = request.payload.taskId;
        if (typeof taskId !== "string" || !run.tasks.has(taskId)) return reject("unknown-task");
        const task = run.tasks.get(taskId)!;
        if (task.status !== "waiting-for-approval") return reject("invalid-task-state");
        const current = task.attempts.at(-1)?.evidenceDigests ?? [];
        const offered = request.payload.evidenceDigests;
        if (!Array.isArray(offered) || canonicalDigest([...offered].sort()) !== canonicalDigest([...current].sort())) {
          return reject("stale-evidence");
        }
        task.status = "complete";
        task.approval = {
          runId: run.runId,
          manifestDigest: run.manifestDigest,
          taskId,
          evidenceDigests: [...current],
          operatorId: principal.operatorId,
        };
        this.settleRun(run);
        return applyNow();
      }
    }
  }

  approval(runId: string, taskId: string): ApprovalBinding | undefined {
    return this.runs.get(runId)?.tasks.get(taskId)?.approval;
  }

  controlRecord(controlId: string): ControlRecordV1 | undefined {
    return this.controls.get(controlId);
  }

  dispatchNext(runId: string): DispatchResult {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running" || run.active) return null;
    for (const taskId of run.effectiveTaskIds) {
      const task = run.tasks.get(taskId)!;
      if (task.status !== "pending") continue;
      const ready = (run.dependencies.get(taskId) ?? []).every((dependency) => {
        const status = run.tasks.get(dependency)?.status;
        return status === "complete" || status === "skipped";
      });
      if (!ready) continue;
      const logicalAttempt = (task.attempts.at(-1)?.logicalAttempt ?? 0) + 1;
      const operationId = randomUUID();
      task.attempts.push({ logicalAttempt, operationId });
      task.status = "running";
      run.active = { taskId, logicalAttempt, operationId, processRunning: true };
      this.touch(run);
      return { taskId, logicalAttempt, operationId };
    }
    return null;
  }

  completeActivity(
    runId: string,
    result: {
      readonly taskId: string;
      readonly logicalAttempt: number;
      readonly operationId: string;
      readonly outcome: "complete" | "failed" | "waiting-for-approval";
      readonly evidenceDigests?: readonly Sha256Digest[];
      readonly diagnostic?: string;
    },
  ): CompletionResult {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, code: "unknown-run" };
    if (result.diagnostic) run.diagnostics.push(result.diagnostic);
    const active = run.active;
    const current = active !== undefined && active.taskId === result.taskId
      && active.logicalAttempt === result.logicalAttempt && active.operationId === result.operationId;
    if (!current || run.status === "cancelling" || run.status === "cancelled") {
      const attempt = run.tasks.get(result.taskId)?.attempts.find((entry) => entry.operationId === result.operationId);
      if (attempt && attempt.outcome === undefined) attempt.outcome = "rejected-late";
      this.touch(run);
      return { ok: false, code: "late-result" };
    }

    const task = run.tasks.get(result.taskId)!;
    const attempt = task.attempts.at(-1)!;
    attempt.outcome = result.outcome;
    if (result.evidenceDigests) attempt.evidenceDigests = [...result.evidenceDigests];
    task.status = result.outcome;
    this.releaseActivity(run);
    return { ok: true };
  }

  observeProcessExit(runId: string, operationId: string): void {
    const run = this.runs.get(runId);
    if (!run?.active || run.active.operationId !== operationId) return;
    run.active.processRunning = false;
    if (run.status === "cancelling") {
      const task = run.tasks.get(run.active.taskId)!;
      task.status = "cancelled";
      const attempt = task.attempts.at(-1)!;
      if (attempt.outcome === undefined) attempt.outcome = "rejected-late";
      run.active = undefined;
      this.cancelRemainingTasks(run);
      run.status = "cancelled";
      if (run.pendingCancelControl) this.advanceControl(run.pendingCancelControl, "applied");
      run.pendingCancelControl = undefined;
    }
    this.touch(run);
  }

  private releaseActivity(run: RunRecord): void {
    run.active = undefined;
    if (run.status === "pausing" || run.status === "stopping") {
      run.status = "paused";
      if (run.pendingBoundaryControl) this.advanceControl(run.pendingBoundaryControl, "applied");
      run.pendingBoundaryControl = undefined;
    }
    this.settleRun(run);
    this.touch(run);
  }

  private settleRun(run: RunRecord): void {
    if (run.status !== "running") return;
    const statuses = [...run.tasks.values()].map((task) => task.status);
    if (statuses.every((status) => status === "complete" || status === "skipped")) run.status = "complete";
    else if (statuses.includes("failed") && !statuses.some((status) => status === "pending" || status === "running")) run.status = "failed";
  }

  private cancelRemainingTasks(run: RunRecord): void {
    for (const task of run.tasks.values()) {
      if (task.status === "pending" || task.status === "ready" || task.status === "running") task.status = "cancelled";
    }
  }

  private touch(run: RunRecord): void {
    run.revision += 1;
  }

  private saveControl(
    request: ControlRequestV1,
    requestDigest: Sha256Digest,
    history: ControlState[],
    reasonCode?: ControlRejectionCode,
  ): ControlRecordV1 {
    const record: ControlRecordV1 = {
      schemaVersion: SCHEMA_VERSION,
      controlId: request.controlId,
      runId: request.runId,
      action: request.action,
      requestDigest,
      state: history.at(-1)!,
      history,
      ...(reasonCode ? { reasonCode } : {}),
    };
    this.controls.set(request.controlId, record);
    return record;
  }

  private advanceControl(controlId: string, state: ControlState): ControlRecordV1 {
    const existing = this.controls.get(controlId)!;
    const record = { ...existing, state, history: [...existing.history, state] };
    this.controls.set(controlId, record);
    return record;
  }
}

// ─── Operation receipts ─────────────────────────────────────────────────────

export type ReceiptResult =
  | { readonly ok: true; readonly receipt: OperationReceiptV1; readonly reused: boolean }
  | { readonly ok: false; readonly code: "stale-revision" | "invalid-transition" | "conflicting-effect" | "unknown-receipt" | "missing-effect-digest" };

function operationKeyString(key: OperationKeyV1): string {
  return `${key.runId}\u0000${key.taskId}\u0000${key.logicalAttempt}\u0000${key.operationId}`;
}

export class ReferenceReceiptStore {
  private readonly receipts = new Map<string, OperationReceiptV1>();

  constructor(private readonly clock = new ManualClock()) {}

  /** Activity (re)delivery: returns the existing receipt for the same logical operation. */
  claim(key: OperationKeyV1): ReceiptResult {
    const id = operationKeyString(key);
    const existing = this.receipts.get(id);
    if (existing) return { ok: true, receipt: existing, reused: true };
    const now = this.clock.now().toISOString();
    const receipt: OperationReceiptV1 = {
      schemaVersion: SCHEMA_VERSION,
      key: { ...key },
      state: "claimed",
      recordVersion: 1,
      createdAt: now,
      updatedAt: now,
      diagnosticRefs: [],
    };
    this.receipts.set(id, receipt);
    return { ok: true, receipt, reused: false };
  }

  get(key: OperationKeyV1): OperationReceiptV1 | undefined {
    return this.receipts.get(operationKeyString(key));
  }

  all(): OperationReceiptV1[] {
    return [...this.receipts.values()];
  }

  transition(
    key: OperationKeyV1,
    expectedVersion: number,
    to: ReceiptState,
    options: { readonly effectDigest?: Sha256Digest; readonly diagnosticRef?: string } = {},
  ): ReceiptResult {
    const id = operationKeyString(key);
    const current = this.receipts.get(id);
    if (!current) return { ok: false, code: "unknown-receipt" };
    if (current.recordVersion !== expectedVersion) return { ok: false, code: "stale-revision" };
    if (options.effectDigest && current.effectDigest && options.effectDigest !== current.effectDigest) {
      return { ok: false, code: "conflicting-effect" };
    }
    if (!canTransitionReceipt(current.state, to)) return { ok: false, code: "invalid-transition" };
    const effectDigest = options.effectDigest ?? current.effectDigest;
    if ((to === "effect-published" || to === "accepted") && !effectDigest) return { ok: false, code: "missing-effect-digest" };
    const next: OperationReceiptV1 = {
      ...current,
      state: to,
      recordVersion: current.recordVersion + 1,
      updatedAt: this.clock.now().toISOString(),
      ...(effectDigest ? { effectDigest } : {}),
      diagnosticRefs: options.diagnosticRef ? [...current.diagnosticRefs, options.diagnosticRef] : current.diagnosticRefs,
    };
    this.receipts.set(id, next);
    return { ok: true, receipt: next, reused: false };
  }
}

// ─── Artifacts and checkpoints ──────────────────────────────────────────────

export type ArtifactResolveResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: "artifact-missing" | "artifact-size-mismatch" | "artifact-digest-mismatch" };

export type ArtifactPublishResult =
  | { readonly ok: true; readonly ref: ArtifactRefV1 }
  | { readonly ok: false; readonly code: "artifact-size-mismatch" | "artifact-digest-mismatch" };

export class ReferenceArtifactStore {
  private readonly objects = new Map<string, Uint8Array>();

  publish(
    bytes: Uint8Array,
    declared: Pick<ArtifactRefV1, "mediaType" | "sizeBytes" | "sha256"> & Partial<Pick<ArtifactRefV1, "sensitivity" | "retentionClass">>,
  ): ArtifactPublishResult {
    const integrity = verifyArtifactBytes(bytes, declared);
    if (!integrity.ok) return { ok: false, code: integrity.code };
    const hex = declared.sha256.slice("sha256:".length);
    const uri = `memory://artifacts/sha256/${hex}`;
    // Content addressing: an accepted digest is never overwritten.
    if (!this.objects.has(uri)) this.objects.set(uri, Uint8Array.from(bytes));
    return {
      ok: true,
      ref: {
        schemaVersion: SCHEMA_VERSION,
        artifactId: `art_${hex.slice(0, 32)}`,
        uri,
        mediaType: declared.mediaType,
        sizeBytes: declared.sizeBytes,
        sha256: declared.sha256,
        ...(declared.sensitivity ? { sensitivity: declared.sensitivity } : {}),
        ...(declared.retentionClass ? { retentionClass: declared.retentionClass } : {}),
      },
    };
  }

  resolve(ref: ArtifactRefV1): ArtifactResolveResult {
    const bytes = this.objects.get(ref.uri);
    if (!bytes) return { ok: false, code: "artifact-missing" };
    const integrity = verifyArtifactBytes(bytes, ref);
    return integrity.ok ? { ok: true, bytes: Uint8Array.from(bytes) } : { ok: false, code: integrity.code };
  }

  delete(ref: ArtifactRefV1): void {
    this.objects.delete(ref.uri);
  }

  /** Test hook simulating storage corruption below the contract boundary. */
  corruptForTest(ref: ArtifactRefV1, bytes: Uint8Array): void {
    this.objects.set(ref.uri, bytes);
  }
}

export type CheckpointResult =
  | { readonly ok: true; readonly digest: Sha256Digest; readonly checkpoint: CheckpointV1 }
  | { readonly ok: false; readonly code: "checkpoint-integrity-failure" | "checkpoint-missing"; readonly failures: readonly string[] };

export class ReferenceCheckpointStore {
  private readonly checkpoints = new Map<Sha256Digest, CheckpointV1>();

  constructor(private readonly artifacts: ReferenceArtifactStore) {}

  publish(checkpoint: CheckpointV1): CheckpointResult {
    const failures = this.verify(checkpoint);
    if (failures.length > 0) return { ok: false, code: "checkpoint-integrity-failure", failures };
    const digest = computeCheckpointDigest(checkpoint);
    if (!this.checkpoints.has(digest)) this.checkpoints.set(digest, structuredClone(checkpoint));
    return { ok: true, digest, checkpoint };
  }

  /** Recovery read: re-verifies every referenced artifact before exposing the checkpoint. */
  resolve(digest: Sha256Digest): CheckpointResult {
    const checkpoint = this.checkpoints.get(digest);
    if (!checkpoint) return { ok: false, code: "checkpoint-missing", failures: [] };
    const failures = this.verify(checkpoint);
    return failures.length > 0
      ? { ok: false, code: "checkpoint-integrity-failure", failures }
      : { ok: true, digest, checkpoint: structuredClone(checkpoint) };
  }

  recoverable(runId: string): Sha256Digest[] {
    return [...this.checkpoints].filter(([digest, checkpoint]) => checkpoint.runId === runId && this.resolve(digest).ok)
      .map(([digest]) => digest);
  }

  private verify(checkpoint: CheckpointV1): string[] {
    return checkpoint.artifacts.flatMap((ref) => {
      const resolved = this.artifacts.resolve(ref);
      return resolved.ok ? [] : [`${ref.artifactId}: ${resolved.code}`];
    });
  }
}

// ─── Repository fencing and integration ─────────────────────────────────────

export type LeaseResult =
  | { readonly ok: true; readonly lease: FencingLeaseV1 }
  | { readonly ok: false; readonly code: "lease-held" };

export type IntegrationResult =
  | { readonly ok: true; readonly commitSha: string; readonly reused: boolean }
  | {
      readonly ok: false;
      readonly code:
        | "no-lease"
        | "stale-fencing-token"
        | "expired-fencing-token"
        | "wrong-owner"
        | "conflicting-integration"
        | "integration-abandoned";
    };

export interface IntegrationRequest {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly fencingToken: number;
  readonly runId: string;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly commitSha: string;
}

export type IntegrationScope = Omit<IntegrationRequest, "fencingToken" | "commitSha">;

export type IntegrationReconciliation =
  | {
      readonly outcome: "integrated";
      readonly commitSha: string;
      readonly checkpointDigest: Sha256Digest;
      readonly effectDigest: Sha256Digest;
      readonly recordedBy: "authority" | "reconciliation";
      readonly backfilled: boolean;
    }
  | { readonly outcome: "not-integrated"; readonly reason: "no-intent" | "commit-not-on-target" }
  | { readonly outcome: "blocked"; readonly reason: "conflicting-operation" };

/** Simulated crash points around the Git ref mutation. */
export type IntegrationCrash = "before-ref-update" | "after-ref-update";

interface IntentRecord {
  readonly operationId: string;
  readonly commitSha?: string;
  state: "pending" | "integrated" | "abandoned";
}

export class ReferenceIntegrationAuthority {
  private readonly leases = new Map<string, FencingLeaseV1>();
  private readonly tokens = new Map<string, number>();
  private readonly integrations = new Map<string, { commitSha: string; operationId: string; recordedBy: "authority" | "reconciliation" }>();
  private readonly intents = new Map<string, IntentRecord>();
  /** Commits reachable from each branch, standing in for the Git repository. */
  private readonly branches = new Map<string, string[]>();
  readonly accepted: IntegrationRequest[] = [];

  constructor(private readonly clock = new ManualClock()) {}

  acquire(repositoryId: string, targetRef: string, runId: string, ttlMs: number): LeaseResult {
    const scope = `${repositoryId}\u0000${targetRef}`;
    const now = this.clock.now();
    const current = this.leases.get(scope);
    if (current && current.ownerRunId !== runId && Date.parse(current.expiresAt) > now.getTime()) return { ok: false, code: "lease-held" };
    const fencingToken = (this.tokens.get(scope) ?? 0) + 1;
    this.tokens.set(scope, fencingToken);
    const lease: FencingLeaseV1 = {
      schemaVersion: SCHEMA_VERSION,
      repositoryId,
      targetRef,
      fencingToken,
      ownerRunId: runId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      revision: (current?.revision ?? 0) + 1,
    };
    this.leases.set(scope, lease);
    return { ok: true, lease };
  }

  branchCommits(repositoryId: string, targetRef: string): readonly string[] {
    return [...(this.branches.get(`${repositoryId}\u0000${targetRef}`) ?? [])];
  }

  /**
   * Fenced integration. The intent is durable before the branch changes; a
   * simulated crash leaves the branch and records as they would be after the
   * process died at that point.
   */
  accept(request: IntegrationRequest, crash?: IntegrationCrash): IntegrationResult {
    const lease = this.leases.get(`${request.repositoryId}\u0000${request.targetRef}`);
    if (!lease) return { ok: false, code: "no-lease" };
    if (request.fencingToken !== lease.fencingToken) return { ok: false, code: "stale-fencing-token" };
    if (Date.parse(lease.expiresAt) <= this.clock.now().getTime()) return { ok: false, code: "expired-fencing-token" };
    if (request.runId !== lease.ownerRunId) return { ok: false, code: "wrong-owner" };
    const attemptKey = this.attemptKey(request);
    const existing = this.integrations.get(attemptKey);
    if (existing !== undefined) {
      return existing.commitSha === request.commitSha
        ? { ok: true, commitSha: existing.commitSha, reused: true }
        : { ok: false, code: "conflicting-integration" };
    }
    const intent = this.intents.get(attemptKey);
    if (intent?.state === "abandoned") return { ok: false, code: "integration-abandoned" };
    if (intent && (intent.operationId !== request.operationId || intent.commitSha !== request.commitSha)) {
      return { ok: false, code: "conflicting-integration" };
    }
    this.intents.set(attemptKey, { operationId: request.operationId, commitSha: request.commitSha, state: "pending" });
    if (crash === "before-ref-update") throw new Error("simulated crash before the Git ref update");

    const branch = this.branch(request);
    if (branch.includes(request.commitSha)) {
      this.record(request, request.commitSha, "reconciliation");
      return { ok: true, commitSha: request.commitSha, reused: true };
    }
    branch.push(request.commitSha);
    if (crash === "after-ref-update") throw new Error("simulated crash after the Git ref update");
    this.record(request, request.commitSha, "authority");
    this.accepted.push(request);
    return { ok: true, commitSha: request.commitSha, reused: false };
  }

  reconcile(scope: IntegrationScope): IntegrationReconciliation {
    const attemptKey = this.attemptKey(scope);
    const record = this.integrations.get(attemptKey);
    const intent = this.intents.get(attemptKey);
    if (record) {
      if (record.operationId !== scope.operationId) return { outcome: "blocked", reason: "conflicting-operation" };
      return this.integrated(scope, record.commitSha, record.recordedBy, false);
    }
    if (!intent) {
      this.intents.set(attemptKey, { operationId: scope.operationId, state: "abandoned" });
      return { outcome: "not-integrated", reason: "no-intent" };
    }
    if (intent.operationId !== scope.operationId) return { outcome: "blocked", reason: "conflicting-operation" };
    if (intent.state === "abandoned" || !intent.commitSha) {
      return { outcome: "not-integrated", reason: intent.commitSha ? "commit-not-on-target" : "no-intent" };
    }
    if (!this.branch(scope).includes(intent.commitSha)) {
      intent.state = "abandoned";
      return { outcome: "not-integrated", reason: "commit-not-on-target" };
    }
    this.record(scope, intent.commitSha, "reconciliation");
    return this.integrated(scope, intent.commitSha, "reconciliation", true);
  }

  private integrated(
    scope: IntegrationScope,
    commitSha: string,
    recordedBy: "authority" | "reconciliation",
    backfilled: boolean,
  ): IntegrationReconciliation {
    const checkpointDigest = canonicalDigest({ checkpointFor: commitSha });
    return {
      outcome: "integrated",
      commitSha,
      checkpointDigest,
      effectDigest: canonicalDigest({ ...scope, commitSha, checkpointDigest }),
      recordedBy,
      backfilled,
    };
  }

  private record(scope: IntegrationScope, commitSha: string, recordedBy: "authority" | "reconciliation"): void {
    const attemptKey = this.attemptKey(scope);
    this.integrations.set(attemptKey, { commitSha, operationId: scope.operationId, recordedBy });
    const intent = this.intents.get(attemptKey);
    if (intent) intent.state = "integrated";
  }

  private branch(scope: IntegrationScope): string[] {
    const key = `${scope.repositoryId}\u0000${scope.targetRef}`;
    const commits = this.branches.get(key) ?? [];
    this.branches.set(key, commits);
    return commits;
  }

  private attemptKey(scope: IntegrationScope): string {
    return `${scope.repositoryId}\u0000${scope.targetRef}\u0000${scope.runId}\u0000${scope.taskId}\u0000${scope.logicalAttempt}`;
  }
}
