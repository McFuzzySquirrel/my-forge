import { SCHEMA_VERSION, type OperationKeyV1 } from "./types.ts";

/**
 * Execution ownership for one operation key (contract v1 §3 "Process
 * lifecycle"). Each delivery that launches a harness process holds an
 * `executionEpoch`; a takeover after worker loss allocates a larger epoch and
 * fences every earlier one. The attempt deadline is fixed when the first epoch
 * starts and survives takeover, so redelivery never resets the time budget.
 *
 * - `running`: the epoch owner may run its process and must renew its heartbeat.
 * - `cancel-requested`: the owner must terminate its process tree and report exit.
 * - `exited`: the owner observed process exit; its outcome awaits admission.
 * - `published`: the outcome was admitted; no later epoch may start.
 * - `lost`: the heartbeat expired; the epoch is fenced and cannot publish.
 */
export type ExecutionState = "running" | "cancel-requested" | "exited" | "published" | "lost";

export type ExecutionStopReason = "deadline" | "cancel" | "ownership-lost";

/** Whether termination of the owned process tree was observed by its owner. */
export type ProcessCleanup = "observed" | "unconfirmed";

export interface ProcessExitV1 {
  /** Exit status, or null when the process was terminated or failed to start. */
  readonly status: number | null;
  readonly stopReason?: ExecutionStopReason;
  readonly cleanup: ProcessCleanup;
  readonly observedAt: string;
}

export interface OperationExecutionV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly key: OperationKeyV1;
  readonly executionEpoch: number;
  readonly workerId: string;
  readonly state: ExecutionState;
  readonly deadlineAt: string;
  readonly heartbeatExpiresAt: string;
  /** Monotonic record revision, incremented by every applied decision. */
  readonly revision: number;
  readonly cancelReason?: string;
  readonly exit?: ProcessExitV1;
  /** Epochs fenced by takeover after worker loss, oldest first. */
  readonly lostEpochs: readonly number[];
}

export interface ExecutionClaimV1 {
  readonly executionEpoch: number;
  readonly workerId: string;
}

/** `receipt-not-executing` is checked by durable stores against the operation receipt. */
export type ExecutionStartRejection =
  | "receipt-not-executing"
  | "execution-held"
  | "cancel-requested"
  | "outcome-published"
  | "deadline-exceeded";

export type ExecutionOwnershipRejection =
  | "unknown-execution"
  | "stale-execution"
  | "execution-expired";

export type OutcomeAdmissionRejection =
  | ExecutionOwnershipRejection
  | "late-result"
  | "process-running"
  | "deadline-exceeded"
  | "cleanup-unconfirmed";

export type ExecutionDecision<Code extends string> =
  | { readonly ok: true; readonly execution: OperationExecutionV1 }
  | { readonly ok: false; readonly code: Code; readonly execution?: OperationExecutionV1 };

export type HeartbeatDirective = "continue" | "cancel" | "deadline";

export const MAX_EXECUTION_TEXT_LENGTH = 512;
export const MAX_LOST_EPOCHS = 32;

const iso = (ms: number): string => new Date(ms).toISOString();

function timestamp(value: string, name: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid execution ${name}: ${value}`);
  return ms;
}

function positiveMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer of milliseconds`);
}

function boundedText(value: string, name: string): void {
  if (!value || value.length > MAX_EXECUTION_TEXT_LENGTH) {
    throw new RangeError(`${name} must contain 1-${MAX_EXECUTION_TEXT_LENGTH} characters`);
  }
}

function next(current: OperationExecutionV1, changes: Partial<OperationExecutionV1>): OperationExecutionV1 {
  return { ...current, ...changes, revision: current.revision + 1 };
}

export function heartbeatExpired(execution: OperationExecutionV1, nowMs: number): boolean {
  return timestamp(execution.heartbeatExpiresAt, "heartbeat expiry") <= nowMs;
}

export function deadlineReached(execution: OperationExecutionV1, nowMs: number): boolean {
  return timestamp(execution.deadlineAt, "deadline") <= nowMs;
}

function owns(execution: OperationExecutionV1 | undefined, claim: ExecutionClaimV1): ExecutionOwnershipRejection | undefined {
  if (!execution) return "unknown-execution";
  if (execution.executionEpoch !== claim.executionEpoch || execution.workerId !== claim.workerId) return "stale-execution";
  if (execution.state === "lost") return "stale-execution";
  return undefined;
}

export interface ExecutionStartInput {
  readonly key: OperationKeyV1;
  readonly workerId: string;
  readonly nowMs: number;
  /** Attempt budget; applied only when the first epoch starts. */
  readonly budgetMs: number;
  readonly heartbeatTtlMs: number;
}

/**
 * Starts the first epoch, or takes over from a lost owner. A live owner, a
 * requested cancellation, an admitted outcome, or an elapsed deadline rejects
 * the start so a redelivered activity never runs a second concurrent process.
 */
export function decideExecutionStart(
  current: OperationExecutionV1 | undefined,
  input: ExecutionStartInput,
): ExecutionDecision<ExecutionStartRejection> {
  boundedText(input.workerId, "Execution worker ID");
  positiveMs(input.budgetMs, "Execution budget");
  positiveMs(input.heartbeatTtlMs, "Execution heartbeat TTL");
  const heartbeatExpiresAt = iso(input.nowMs + input.heartbeatTtlMs);
  if (!current) {
    return {
      ok: true,
      execution: {
        schemaVersion: SCHEMA_VERSION,
        key: input.key,
        executionEpoch: 1,
        workerId: input.workerId,
        state: "running",
        deadlineAt: iso(input.nowMs + input.budgetMs),
        heartbeatExpiresAt,
        revision: 1,
        lostEpochs: [],
      },
    };
  }
  if (current.state === "published") return { ok: false, code: "outcome-published", execution: current };
  if (current.cancelReason !== undefined) return { ok: false, code: "cancel-requested", execution: current };
  // An owner that is running, or has exited but not yet submitted its outcome,
  // keeps the execution until its heartbeat expires.
  if (current.state !== "lost" && !heartbeatExpired(current, input.nowMs)) {
    return { ok: false, code: "execution-held", execution: current };
  }
  if (deadlineReached(current, input.nowMs)) return { ok: false, code: "deadline-exceeded", execution: current };
  const lostEpochs = current.state === "running"
    ? [...current.lostEpochs, current.executionEpoch]
    : current.lostEpochs;
  return {
    ok: true,
    execution: next(current, {
      executionEpoch: current.executionEpoch + 1,
      workerId: input.workerId,
      state: "running",
      heartbeatExpiresAt,
      exit: undefined,
      lostEpochs: lostEpochs.slice(-MAX_LOST_EPOCHS),
    }),
  };
}

/**
 * Renews the owner's heartbeat and tells it whether to keep running. An
 * expired heartbeat is not renewable: the owner must stop even before another
 * worker takes over, because recovery may already treat the epoch as lost.
 */
export function decideHeartbeat(
  current: OperationExecutionV1 | undefined,
  claim: ExecutionClaimV1,
  input: { readonly nowMs: number; readonly heartbeatTtlMs: number },
): ExecutionDecision<ExecutionOwnershipRejection> & { readonly directive?: HeartbeatDirective } {
  positiveMs(input.heartbeatTtlMs, "Execution heartbeat TTL");
  const rejection = owns(current, claim);
  if (rejection) return { ok: false, code: rejection, ...(current ? { execution: current } : {}) };
  const execution = current!;
  if (execution.state !== "running" && execution.state !== "cancel-requested") {
    return { ok: false, code: "stale-execution", execution };
  }
  if (heartbeatExpired(execution, input.nowMs)) return { ok: false, code: "execution-expired", execution };
  const directive: HeartbeatDirective = execution.state === "cancel-requested"
    ? "cancel"
    : deadlineReached(execution, input.nowMs) ? "deadline" : "continue";
  return {
    ok: true,
    directive,
    execution: next(execution, { heartbeatExpiresAt: iso(input.nowMs + input.heartbeatTtlMs) }),
  };
}

/**
 * Requests termination of the owned process tree. Acceptance records intent
 * only; it is not evidence that the process stopped. A cancel that arrives
 * after exit but before admission still fences the outcome as late.
 */
export function decideCancel(
  current: OperationExecutionV1 | undefined,
  reason: string,
): ExecutionDecision<"unknown-execution" | "outcome-published"> & { readonly reused?: boolean } {
  boundedText(reason, "Cancellation reason");
  if (!current) return { ok: false, code: "unknown-execution" };
  if (current.state === "published") return { ok: false, code: "outcome-published", execution: current };
  if (current.cancelReason !== undefined) return { ok: true, execution: current, reused: true };
  return {
    ok: true,
    execution: next(current, {
      cancelReason: reason,
      state: current.state === "running" ? "cancel-requested" : current.state,
    }),
  };
}

/** Records the owner's observation that its process tree exited. */
export function decideProcessExit(
  current: OperationExecutionV1 | undefined,
  claim: ExecutionClaimV1,
  exit: Omit<ProcessExitV1, "observedAt">,
  nowMs: number,
): ExecutionDecision<ExecutionOwnershipRejection> & { readonly reused?: boolean } {
  const rejection = owns(current, claim);
  if (rejection) return { ok: false, code: rejection, ...(current ? { execution: current } : {}) };
  const execution = current!;
  if (execution.state === "exited" || execution.state === "published") {
    return { ok: true, execution, reused: true };
  }
  return { ok: true, execution: next(execution, { state: "exited", exit: { ...exit, observedAt: iso(nowMs) } }) };
}

/**
 * Admits the owner's outcome only for the current epoch, after its process
 * exit was observed, and without a cancellation; anything else is a late or
 * stale outcome. An `effect` additionally requires confirmed cleanup and an
 * exit within the deadline. A `failure` (including a timeout) stays admissible
 * so the attempt can settle without accepting any effect.
 */
export function decideOutcomeAdmission(
  current: OperationExecutionV1 | undefined,
  claim: ExecutionClaimV1,
  outcome: "effect" | "failure",
): ExecutionDecision<OutcomeAdmissionRejection> {
  const rejection = owns(current, claim);
  if (rejection) return { ok: false, code: rejection, ...(current ? { execution: current } : {}) };
  const execution = current!;
  if (execution.cancelReason !== undefined) return { ok: false, code: "late-result", execution };
  if (execution.state === "published") return { ok: false, code: "stale-execution", execution };
  if (execution.state !== "exited" || !execution.exit) return { ok: false, code: "process-running", execution };
  if (outcome === "effect") {
    if (execution.exit.cleanup !== "observed") return { ok: false, code: "cleanup-unconfirmed", execution };
    if (execution.exit.stopReason === "cancel") return { ok: false, code: "late-result", execution };
    if (
      execution.exit.stopReason === "deadline" ||
      timestamp(execution.exit.observedAt, "exit observation") > timestamp(execution.deadlineAt, "deadline")
    ) {
      return { ok: false, code: "deadline-exceeded", execution };
    }
  }
  return { ok: true, execution: next(execution, { state: "published" }) };
}

/** Fences an epoch whose heartbeat expired so no later report from it is admitted. */
export function decideExecutionLost(
  current: OperationExecutionV1 | undefined,
  nowMs: number,
): ExecutionDecision<"unknown-execution" | "execution-live" | "not-running"> {
  if (!current) return { ok: false, code: "unknown-execution" };
  if (current.state !== "running" && current.state !== "cancel-requested") {
    return { ok: false, code: "not-running", execution: current };
  }
  if (!heartbeatExpired(current, nowMs)) return { ok: false, code: "execution-live", execution: current };
  return {
    ok: true,
    execution: next(current, {
      state: "lost",
      lostEpochs: [...current.lostEpochs, current.executionEpoch].slice(-MAX_LOST_EPOCHS),
    }),
  };
}
