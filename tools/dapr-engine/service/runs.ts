import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SCHEMA_VERSION,
  validateSubmission,
  type ApprovalContextV1,
  type ControlAction,
  type ControlRequestV1,
  type JsonValue,
  type RunLifecycleEventPageV1,
  type RunStatusCreateV1,
  type RunStatusSnapshotV1,
  type RunSubmissionV1,
  type TrustedPrincipalV1,
} from "../contract/v1/index.ts";
import { StubAdapter } from "../execution/harness/stub-adapter.ts";
import type { AgentDescriptor, HarnessAdapter, ManifestTask } from "../execution/types.ts";
import {
  executionHostRunFromSubmission,
  type ExecutionHostRunV1,
} from "../orchestration/execution-host.ts";
import { RUN_LIMITS_V1, utf8JsonBytes } from "../orchestration/limits.ts";
import { buildOrchestrationPlan, type AcceptedRunSubmissionV1 } from "../orchestration/planner.ts";
import type { RunControlEffects } from "../orchestration/run-control.ts";
import type { RunLifecycleEventWriter } from "../orchestration/status-activity.ts";
import { runOrchestrationWorkflowId, type RunWorkflowInputV1 } from "../orchestration/workflow.ts";
import type { ControlStoreResult, StoredControlRecordV1 } from "../storage/postgres/control-records.ts";
import type {
  RunSubmissionCreateResult,
  StoredRunSubmissionV1,
} from "../storage/postgres/run-submissions.ts";
import type { OperationKeyV1 } from "../contract/v1/index.ts";

/** Repository IDs name the `/repositories/<id>` mount; they never carry paths. */
export const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const LOCAL_OPERATOR: TrustedPrincipalV1 = Object.freeze({
  subject: "local-operator",
  roles: Object.freeze(["operator"]),
});
const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const API_CONTROL_ACTIONS: ReadonlySet<ControlAction> = new Set([
  "pause", "resume", "stop", "cancel", "replay-task", "approve-task",
]);

export interface ServiceHarnessV1 {
  readonly adapterVersions: readonly string[];
  create(): HarnessAdapter;
}

/**
 * Harnesses the containerized worker can execute. Real CLI harnesses need a
 * provisioned binary and an explicit credential grant inside the worker, which
 * the local profile does not provide yet; they are rejected at submission.
 */
export function defaultServiceHarnesses(): ReadonlyMap<string, ServiceHarnessV1> {
  return new Map([["stub", { adapterVersions: ["1"], create: () => new StubAdapter() }]]);
}

/** Resolves a registered repository to its mount: `<root>/<id>` with a real `.git` directory. */
export function mountedRepositoryResolver(root: string): (repositoryId: string) => string | undefined {
  return (repositoryId) => {
    if (!REPOSITORY_ID_PATTERN.test(repositoryId)) return undefined;
    const repository = join(root, repositoryId);
    try {
      const gitDirectory = lstatSync(join(repository, ".git"));
      return gitDirectory.isDirectory() && !gitDirectory.isSymbolicLink() ? repository : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The branch the user's worktree has checked out; integrating into it would desync that worktree. */
export function checkedOutBranch(repositoryRoot: string): string | undefined {
  try {
    const head = readFileSync(join(repositoryRoot, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: ") ? head.slice(5) : undefined;
  } catch {
    return undefined;
  }
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Agent descriptors frozen into the manifest snapshot by the submitting client. */
export function snapshotAgents(submission: AcceptedRunSubmissionV1): ReadonlyMap<string, AgentDescriptor> {
  const agents = new Map<string, AgentDescriptor>();
  const raw = (submission.manifestSnapshot as { agents?: unknown }).agents;
  if (!Array.isArray(raw)) return agents;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !candidate.name) continue;
    agents.set(candidate.name, {
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : "",
      path: typeof candidate.path === "string" ? candidate.path : "",
      ...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
      ...(typeof candidate.modelFallback === "string" ? { modelFallback: candidate.modelFallback } : {}),
      expertise: textArray(candidate.expertise),
      collaboration: textArray(candidate.collaboration),
      constraints: textArray(candidate.constraints),
      rawBody: typeof candidate.rawBody === "string" ? candidate.rawBody : "",
    });
  }
  return agents;
}

function fallbackAgent(name: string): AgentDescriptor {
  return { name, description: "", path: "", expertise: [], collaboration: [], constraints: [], rawBody: "" };
}

/** In-memory run bindings for the synchronous ExecutionHost resolver. */
export class ServiceRunRegistry {
  private readonly runs = new Map<string, ExecutionHostRunV1>();

  constructor(private readonly harnesses: ReadonlyMap<string, ServiceHarnessV1>) {}

  harnessAvailable(harness: RunSubmissionV1["harness"]): boolean {
    return this.harnesses.get(harness.id)?.adapterVersions.includes(harness.adapterVersion) === true;
  }

  /** Throws when the snapshot cannot be executed by this worker. */
  bind(runId: string, submission: AcceptedRunSubmissionV1): ExecutionHostRunV1 {
    const harness = this.harnesses.get(submission.harness.id);
    if (!harness || !harness.adapterVersions.includes(submission.harness.adapterVersion)) {
      throw new Error(`Harness '${submission.harness.id}@${submission.harness.adapterVersion}' is not available in this worker`);
    }
    const agents = snapshotAgents(submission);
    const run = executionHostRunFromSubmission(runId, submission, {
      agentFor: (task: ManifestTask) => agents.get(task.ownerAgent ?? "") ?? fallbackAgent(task.ownerAgent ?? "forge-agent"),
      harness: harness.create(),
    });
    this.runs.set(runId, run);
    return run;
  }

  get(runId: string): ExecutionHostRunV1 | undefined {
    return this.runs.get(runId);
  }
}

export interface ServiceExecutionStore {
  listActive(runId: string): Promise<readonly OperationKeyV1[]>;
  requestCancel(key: OperationKeyV1, reason: string): Promise<unknown>;
  fenceLostExecutions(limit?: number): Promise<unknown>;
}

/** Production run-control effects for the local worker. */
export function createServiceRunControlEffects(dependencies: {
  readonly executions: ServiceExecutionStore;
  readonly replays: { allocateReplayAttempt(controlId: string, runId: string, taskId: string): Promise<number> };
  readonly cancelTimeoutMs?: number;
  readonly pollMs?: number;
}): RunControlEffects {
  const timeoutMs = dependencies.cancelTimeoutMs ?? 120_000;
  const pollMs = dependencies.pollMs ?? 500;
  return {
    // The workflow stops dispatching; running attempts finish at their task boundary.
    pauseOrStop: async () => undefined,
    resume: async () => undefined,
    async cancel(record: StoredControlRecordV1) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const active = await dependencies.executions.listActive(record.runId);
        if (active.length === 0) return;
        for (const key of active) {
          await dependencies.executions.requestCancel(key, `Run cancelled by control ${record.controlId}`);
        }
        await dependencies.executions.fenceLostExecutions();
        if (Date.now() >= deadline) {
          throw new Error(`Run '${record.runId}' cancellation is still waiting for ${active.length} process(es) to exit`);
        }
        await delay(pollMs);
      }
    },
    async replayTask(record: StoredControlRecordV1) {
      const taskId = record.payload.taskId;
      if (typeof taskId !== "string" || !taskId) throw new Error("Replay control requires payload.taskId");
      return dependencies.replays.allocateReplayAttempt(record.controlId, record.runId, taskId);
    },
  };
}

export type RunServiceResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly detail: string };

export interface RunServiceDependencies {
  readonly submissions: {
    create(input: { runId: string; snapshotDigest: StoredRunSubmissionV1["snapshotDigest"]; submission: AcceptedRunSubmissionV1 }): Promise<RunSubmissionCreateResult>;
    get(runId: string): Promise<StoredRunSubmissionV1 | undefined>;
    list(limit: number, repositoryId?: string): Promise<readonly StoredRunSubmissionV1[]>;
  };
  readonly status: {
    createRun(input: RunStatusCreateV1): Promise<unknown>;
    getRunStatus(runId: string): Promise<RunStatusSnapshotV1 | undefined>;
    listEvents(runId: string, afterSequence?: number, limit?: number): Promise<RunLifecycleEventPageV1>;
  };
  readonly registry: ServiceRunRegistry;
  readonly repositoryRoot: (repositoryId: string) => string | undefined;
  readonly checkedOutBranch?: (repositoryRoot: string) => string | undefined;
  /** Schedules the run workflow; must be idempotent per instance ID. */
  readonly scheduleRun: (instanceId: string, input: RunWorkflowInputV1) => Promise<void>;
  readonly runControls: { request(request: ControlRequestV1, principal: TrustedPrincipalV1): Promise<ControlStoreResult> };
  readonly approvals: {
    approve(request: ControlRequestV1, principal: TrustedPrincipalV1, context: ApprovalContextV1 | undefined): Promise<ControlStoreResult>;
  };
  readonly approvalContext: (runId: string, taskId: string) => Promise<ApprovalContextV1 | undefined>;
  readonly newRunId?: () => string;
}

function reject(status: number, code: string, detail: string): RunServiceResult {
  return { ok: false, status, code, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlStatus(code: string): number {
  if (code === "unknown-run") return 404;
  if (code === "control-conflict" || code === "stale-revision" || code === "invalid-transition") return 409;
  if (code === "unauthorized") return 403;
  return 422;
}

function summary(record: StoredRunSubmissionV1, status: RunStatusSnapshotV1 | undefined): Record<string, unknown> {
  const submission = record.submission;
  return {
    runId: record.runId,
    submissionKey: record.submissionKey,
    repositoryId: record.repositoryId,
    targetRef: submission.targetRef,
    manifestDigest: submission.manifestDigest,
    harness: submission.harness,
    taskIds: submission.selection.effectiveTaskIds ?? [],
    createdAt: record.createdAt,
    status: status?.status ?? "queued",
    revision: status?.revision ?? 0,
  };
}

/** Submission, status, and control operations behind the authenticated local API. */
export class RunService {
  constructor(private readonly dependencies: RunServiceDependencies) {}

  async submit(body: unknown): Promise<RunServiceResult> {
    if (!isRecord(body)) return reject(400, "invalid-submission", "Request body must be a run submission object");
    const submission = body as unknown as RunSubmissionV1;
    if (typeof submission.submissionKey !== "string" || !SUBMISSION_KEY_PATTERN.test(submission.submissionKey)) {
      return reject(422, "invalid-submission", "submissionKey must be 1-256 safe characters");
    }
    if (typeof submission.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(submission.repositoryId)) {
      return reject(422, "invalid-submission", "repositoryId must match ^[a-z0-9][a-z0-9_-]{0,63}$");
    }
    if (typeof submission.targetRef !== "string" || !TARGET_REF_PATTERN.test(submission.targetRef)
      || submission.targetRef.includes("..") || submission.targetRef.endsWith("/") || submission.targetRef.endsWith(".lock")) {
      return reject(422, "invalid-submission", "targetRef must be a refs/heads/ branch");
    }
    if (!isRecord(submission.harness) || !isRecord(submission.configuration) || !isRecord(submission.selection)
      || !isRecord(submission.manifestSnapshot) || !Array.isArray(submission.manifestSnapshot.phases)) {
      return reject(422, "invalid-submission", "Submission is missing harness, configuration, selection, or manifest phases");
    }
    if (utf8JsonBytes(submission) > RUN_LIMITS_V1.maxWorkflowInputBytes) {
      return reject(413, "run-limit-exceeded", `Submission exceeds ${RUN_LIMITS_V1.maxWorkflowInputBytes} bytes`);
    }
    if (!this.dependencies.registry.harnessAvailable(submission.harness)) {
      return reject(422, "harness-unavailable",
        `Harness '${String(submission.harness.id)}@${String(submission.harness.adapterVersion)}' is not available in the local service worker`);
    }
    const repositoryRoot = this.dependencies.repositoryRoot(submission.repositoryId);
    if (!repositoryRoot) {
      return reject(422, "repository-unavailable",
        `Repository '${submission.repositoryId}' is not registered with the local runtime`);
    }
    if ((this.dependencies.checkedOutBranch ?? checkedOutBranch)(repositoryRoot) === submission.targetRef) {
      return reject(409, "target-ref-checked-out",
        `${submission.targetRef} is checked out in the repository worktree; submit to a dedicated forge/ branch`);
    }
    const validation = validateSubmission(submission);
    if (!validation.ok) return reject(422, validation.code, validation.detail);
    const accepted: AcceptedRunSubmissionV1 = {
      ...submission,
      selection: {
        mode: submission.selection.mode,
        requestedTaskIds: submission.selection.requestedTaskIds,
        effectiveTaskIds: validation.effectiveTaskIds,
      },
    };
    try {
      buildOrchestrationPlan(accepted);
      executionHostRunFromSubmission("run_validation", accepted, {
        agentFor: () => fallbackAgent("validation"),
        harness: new StubAdapter(),
      });
    } catch (error) {
      return reject(422, "invalid-submission", error instanceof Error ? error.message : "Submission cannot be planned");
    }

    const runId = this.dependencies.newRunId?.() ?? `run_${randomUUID().replaceAll("-", "")}`;
    const stored = await this.dependencies.submissions.create({
      runId,
      snapshotDigest: validation.snapshotDigest,
      submission: accepted,
    });
    if (!stored.ok) {
      return reject(409, stored.code, "submissionKey was already used for a different run snapshot");
    }
    await this.start(stored.record);
    const status = await this.dependencies.status.getRunStatus(stored.record.runId);
    return { ok: true, status: stored.reused ? 200 : 201, body: { ...summary(stored.record, status), reused: stored.reused } };
  }

  /** Binds, records, and schedules one stored run; safe to repeat. */
  async start(record: StoredRunSubmissionV1): Promise<void> {
    const submission = record.submission;
    if (!this.dependencies.registry.get(record.runId)) this.dependencies.registry.bind(record.runId, submission);
    await this.dependencies.status.createRun({
      schemaVersion: SCHEMA_VERSION,
      runId: record.runId,
      repositoryId: submission.repositoryId,
      targetRef: submission.targetRef,
      manifestDigest: submission.manifestDigest,
      taskIds: submission.selection.effectiveTaskIds ?? [],
    });
    await this.dependencies.scheduleRun(runOrchestrationWorkflowId(record.runId), {
      runId: record.runId,
      submission,
      controlsEnabled: true,
      statusEnabled: true,
    });
  }

  /** Binds stored runs before the workflow worker starts so replayed activities can resolve them. */
  async bindStored(onError: (runId: string, error: unknown) => void): Promise<number> {
    let bound = 0;
    for (const record of await this.dependencies.submissions.list(10_000)) {
      try {
        if (!this.dependencies.registry.get(record.runId)) this.dependencies.registry.bind(record.runId, record.submission);
        bound += 1;
      } catch (error) {
        onError(record.runId, error);
      }
    }
    return bound;
  }

  /** Re-records and reschedules every stored run after a restart; a run that cannot be bound is reported, not fatal. */
  async recover(onError: (runId: string, error: unknown) => void): Promise<number> {
    let recovered = 0;
    for (const record of await this.dependencies.submissions.list(10_000)) {
      try {
        await this.start(record);
        recovered += 1;
      } catch (error) {
        onError(record.runId, error);
      }
    }
    return recovered;
  }

  async list(limit: number, repositoryId?: string): Promise<RunServiceResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return reject(400, "invalid-request", "limit must be between 1 and 200");
    }
    if (repositoryId !== undefined && !REPOSITORY_ID_PATTERN.test(repositoryId)) {
      return reject(400, "invalid-request", "repositoryId is invalid");
    }
    const records = await this.dependencies.submissions.list(limit, repositoryId);
    const runs = [];
    for (const record of records) {
      runs.push(summary(record, await this.dependencies.status.getRunStatus(record.runId)));
    }
    return { ok: true, status: 200, body: { runs } };
  }

  async get(runId: string): Promise<RunServiceResult> {
    const record = await this.dependencies.submissions.get(runId);
    if (!record) return reject(404, "unknown-run", `Run '${runId}' does not exist`);
    const status = await this.dependencies.status.getRunStatus(runId);
    return { ok: true, status: 200, body: { ...summary(record, status), tasks: status?.tasks ?? [] } };
  }

  async events(runId: string, after: number, limit: number): Promise<RunServiceResult> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return reject(400, "invalid-request", "after must be >= 0 and limit between 1 and 500");
    }
    if (!await this.dependencies.submissions.get(runId)) return reject(404, "unknown-run", `Run '${runId}' does not exist`);
    return { ok: true, status: 200, body: await this.dependencies.status.listEvents(runId, after, limit) };
  }

  async control(runId: string, body: unknown, principal: TrustedPrincipalV1 = LOCAL_OPERATOR): Promise<RunServiceResult> {
    if (!isRecord(body)) return reject(400, "invalid-control", "Request body must be a control object");
    const action = body.action as ControlAction;
    if (typeof action !== "string" || !API_CONTROL_ACTIONS.has(action)) {
      return reject(422, "invalid-control", `action must be one of ${[...API_CONTROL_ACTIONS].join(", ")}`);
    }
    const controlId = body.controlId ?? randomUUID();
    if (typeof controlId !== "string" || !UUID_PATTERN.test(controlId)) {
      return reject(422, "invalid-control", "controlId must be a UUID");
    }
    if (body.payload !== undefined && !isRecord(body.payload)) {
      return reject(422, "invalid-control", "payload must be an object");
    }
    if (!await this.dependencies.submissions.get(runId)) return reject(404, "unknown-run", `Run '${runId}' does not exist`);
    let payload = { ...(body.payload as Record<string, JsonValue> | undefined) };
    let result: ControlStoreResult;
    if (action === "approve-task") {
      if (typeof payload.taskId !== "string" || !payload.taskId) {
        return reject(422, "invalid-control", "approve-task requires payload.taskId");
      }
      const context = await this.dependencies.approvalContext(runId, payload.taskId);
      if (!context) return reject(409, "invalid-transition", `Task '${payload.taskId}' is not waiting for approval`);
      if (payload.evidenceDigests === undefined) payload = { ...payload, evidenceDigests: [...context.evidenceDigests] };
      result = await this.dependencies.approvals.approve(
        { schemaVersion: SCHEMA_VERSION, controlId, runId, action, payload },
        principal,
        context,
      );
    } else {
      if (action === "replay-task" && (typeof payload.taskId !== "string" || !payload.taskId)) {
        return reject(422, "invalid-control", "replay-task requires payload.taskId");
      }
      result = await this.dependencies.runControls.request(
        { schemaVersion: SCHEMA_VERSION, controlId, runId, action, payload },
        principal,
      );
    }
    if (!result.ok) return reject(controlStatus(result.code), result.code, `Control ${action} was not accepted`);
    const record = result.record;
    if (record.state === "rejected") {
      const code = record.reasonCode ?? "rejected";
      return reject(controlStatus(code), code, `Control ${action} was rejected`);
    }
    return {
      ok: true,
      status: result.reused ? 200 : 202,
      body: { controlId: record.controlId, runId: record.runId, action: record.action, state: record.state, reused: result.reused },
    };
  }
}

const LEASE_RELEASING_STATUSES = new Set(["complete", "failed", "cancelled"]);

/**
 * Wraps the lifecycle writer so a run's repository leases are released once it
 * records a terminal status. Release failures are reported, not thrown: leases
 * still expire by TTL, and a replayed run reacquires its lease.
 */
export function leaseReleasingLifecycleWriter(
  writer: RunLifecycleEventWriter,
  releaseRun: (runId: string) => Promise<unknown>,
  onReleaseError: (runId: string, error: unknown) => void,
): RunLifecycleEventWriter {
  return {
    async appendEvent(input) {
      const appended = await writer.appendEvent(input);
      if (input.runStatus !== undefined && LEASE_RELEASING_STATUSES.has(input.runStatus)) {
        await releaseRun(input.runId).catch((error: unknown) => onReleaseError(input.runId, error));
      }
      return appended;
    },
  };
}
