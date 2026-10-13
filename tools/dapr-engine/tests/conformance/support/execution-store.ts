import {
  canTransitionReceipt,
  decideCancel,
  decideExecutionLost,
  decideExecutionStart,
  decideHeartbeat,
  decideOutcomeAdmission,
  decideProcessExit,
  type ExecutionClaimV1,
  type OperationExecutionV1,
  type OperationKeyV1,
  type ProcessExitV1,
  type ReceiptState,
} from "../../../contract/v1/index.ts";
import type { ExecutionOwnershipStore } from "../../../execution/process-lifecycle.ts";

const id = (key: OperationKeyV1) => JSON.stringify([key.runId, key.taskId, key.logicalAttempt, key.operationId]);

/**
 * In-memory execution ownership using the contract v1 decision functions,
 * mirroring PostgresExecutionOwnershipStore for fixtures. `advance` moves the
 * store clock to simulate expiry without waiting.
 */
export class InMemoryExecutionStore implements ExecutionOwnershipStore {
  readonly executions = new Map<string, OperationExecutionV1>();
  readonly receipts = new Map<string, { state: ReceiptState; diagnostics: string[] }>();
  private offsetMs = 0;

  now(): number {
    return Date.now() + this.offsetMs;
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  executingReceipt(key: OperationKeyV1): void {
    this.receipts.set(id(key), { state: "executing", diagnostics: [] });
  }

  receipt(key: OperationKeyV1) {
    return this.receipts.get(id(key));
  }

  execution(key: OperationKeyV1) {
    return this.executions.get(id(key));
  }

  async start(input: { key: OperationKeyV1; workerId: string; budgetMs: number; heartbeatTtlMs: number }) {
    if (this.receipt(input.key)?.state !== "executing") return { ok: false as const, code: "receipt-not-executing" as const };
    const decision = decideExecutionStart(this.execution(input.key), { ...input, nowMs: this.now() });
    if (decision.ok) this.executions.set(id(input.key), decision.execution);
    return decision;
  }

  async heartbeat(key: OperationKeyV1, claim: ExecutionClaimV1, heartbeatTtlMs: number) {
    const decision = decideHeartbeat(this.execution(key), claim, { nowMs: this.now(), heartbeatTtlMs });
    if (!decision.ok) return { ok: false as const, code: decision.code };
    this.executions.set(id(key), decision.execution);
    return { ok: true as const, directive: decision.directive ?? "continue", execution: decision.execution };
  }

  async recordExit(key: OperationKeyV1, claim: ExecutionClaimV1, exit: Omit<ProcessExitV1, "observedAt">) {
    const decision = decideProcessExit(this.execution(key), claim, exit, this.now());
    if (!decision.ok) return { ok: false as const, code: decision.code };
    this.executions.set(id(key), decision.execution);
    return { ok: true as const, execution: decision.execution };
  }

  requestCancel(key: OperationKeyV1, reason: string) {
    const decision = decideCancel(this.execution(key), reason);
    if (decision.ok) this.executions.set(id(key), decision.execution);
    return decision;
  }

  publishOutcome(key: OperationKeyV1, claim: ExecutionClaimV1, to: "effect-published" | "failed", diagnostic?: string) {
    const decision = decideOutcomeAdmission(this.execution(key), claim, to === "effect-published" ? "effect" : "failure");
    const receipt = this.receipt(key);
    if (!decision.ok) {
      if (decision.code === "late-result" && receipt?.state === "executing") {
        receipt.state = "failed";
        receipt.diagnostics.push(diagnostic ?? `execution:late-result:epoch-${claim.executionEpoch}`);
      }
      return { ok: false as const, code: decision.code };
    }
    if (!receipt || !canTransitionReceipt(receipt.state, to)) return { ok: false as const, code: "receipt-rejected" as const };
    this.executions.set(id(key), decision.execution);
    receipt.state = to;
    if (diagnostic) receipt.diagnostics.push(diagnostic);
    return { ok: true as const };
  }

  fenceLostExecutions() {
    const lost: OperationExecutionV1[] = [];
    for (const [key, execution] of this.executions) {
      const decision = decideExecutionLost(execution, this.now());
      if (!decision.ok) continue;
      this.executions.set(key, decision.execution);
      const receipt = this.receipts.get(key);
      if (execution.cancelReason !== undefined && receipt?.state === "executing") {
        receipt.state = "failed";
        receipt.diagnostics.push(`execution:cancelled-worker-lost:epoch-${execution.executionEpoch}:cleanup-unconfirmed`);
      }
      lost.push(decision.execution);
    }
    return lost;
  }
}
