import { isTerminalReceipt, type OperationReceiptV1, type ReceiptState, type Sha256Digest } from "../contract/v1/index.ts";
import type { PostgresOperationReceiptStore, ReceiptStoreResult } from "./postgres/operation-receipts.ts";
import type {
  PostgresRepositoryIntegrationAuthority,
  RepositoryIntegrationReconciliation,
  RepositoryIntegrationScope,
} from "./postgres/repository-integration.ts";

const MAX_RECONCILIATION_STEPS = 8;

export type IntegrationReceiptResolution = "accepted" | "failed" | "blocked";

export interface IntegrationReceiptReconciliationResult {
  readonly receipt: OperationReceiptV1;
  readonly resolution: IntegrationReceiptResolution;
  /** Absent when the receipt was already terminal and Git was not consulted. */
  readonly integration?: RepositoryIntegrationReconciliation;
  readonly blockedReason?: string;
}

type ReceiptPort = Pick<PostgresOperationReceiptStore, "get" | "transition">;
type IntegrationPort = Pick<PostgresRepositoryIntegrationAuthority, "reconcile">;

interface Step {
  readonly to: ReceiptState;
  readonly effectDigest?: Sha256Digest;
  readonly diagnosticRef?: string;
}

function diagnosticFor(integration: RepositoryIntegrationReconciliation): string {
  switch (integration.outcome) {
    case "integrated":
      return `git-integration:${integration.recordedBy}:${integration.commitSha}`;
    case "not-integrated":
      return `git-integration:not-integrated:${integration.reason}`;
    case "blocked":
      return `git-integration:blocked:${integration.reason}`;
  }
}

/** The next receipt transition toward the reconciled outcome, or undefined when none is allowed. */
function nextStep(state: ReceiptState, integration: RepositoryIntegrationReconciliation): Step | undefined {
  const diagnosticRef = diagnosticFor(integration);
  if (integration.outcome === "integrated") {
    const effectDigest = integration.effectDigest;
    switch (state) {
      case "claimed": return { to: "executing" };
      case "executing": return { to: "effect-published", effectDigest };
      case "effect-published": return { to: "accepted", effectDigest, diagnosticRef };
      case "ambiguous": return { to: "accepted", effectDigest, diagnosticRef };
      default: return undefined;
    }
  }
  const terminal: ReceiptState = integration.outcome === "not-integrated" ? "failed" : "ambiguous";
  switch (state) {
    case "claimed": return { to: "executing" };
    case "executing": return { to: terminal, diagnosticRef };
    case "ambiguous": return terminal === "failed" ? { to: "failed", diagnosticRef } : undefined;
    default: return undefined;
  }
}

function resolutionOf(receipt: OperationReceiptV1): IntegrationReceiptResolution {
  if (receipt.state === "accepted") return "accepted";
  if (receipt.state === "failed") return "failed";
  return "blocked";
}

/**
 * Reconciles a repository-integration receipt after a crash or ambiguous
 * result (contract v1 §3, P3-05). Git, not the receipt, decides the outcome:
 * an integrated commit with a verified checkpoint is accepted once under the
 * integration effect digest; an absent commit fails the logical attempt and
 * fences its late integration; anything else leaves the receipt ambiguous so
 * continuation stays blocked. Retries allocate a new logical attempt.
 */
export async function reconcileIntegrationReceipt(
  receipts: ReceiptPort,
  authority: IntegrationPort,
  scope: RepositoryIntegrationScope,
): Promise<IntegrationReceiptReconciliationResult> {
  const key = {
    runId: scope.runId,
    taskId: scope.taskId,
    logicalAttempt: scope.logicalAttempt,
    operationId: scope.operationId,
  };
  let receipt = await receipts.get(key);
  if (!receipt) throw new Error(`No operation receipt exists for ${scope.runId}/${scope.taskId}/${scope.logicalAttempt}/${scope.operationId}`);
  if (isTerminalReceipt(receipt.state)) return { receipt, resolution: resolutionOf(receipt) };

  const integration = await authority.reconcile(scope);
  for (let steps = 0; steps < MAX_RECONCILIATION_STEPS; steps += 1) {
    const step = nextStep(receipt.state, integration);
    if (!step) break;
    const result: ReceiptStoreResult = await receipts.transition(key, receipt.recordVersion, step.to, {
      ...(step.effectDigest ? { effectDigest: step.effectDigest } : {}),
      ...(step.diagnosticRef ? { diagnosticRef: step.diagnosticRef } : {}),
    });
    if (result.ok) {
      receipt = result.receipt;
      continue;
    }
    if (result.code === "conflicting-effect") {
      return { receipt, resolution: "blocked", integration, blockedReason: "conflicting-effect" };
    }
    if (result.code !== "stale-revision") {
      throw new Error(`Receipt reconciliation transition ${receipt.state} -> ${step.to} failed: ${result.code}`);
    }
    const latest = await receipts.get(key);
    if (!latest) throw new Error("Operation receipt disappeared during reconciliation");
    receipt = latest;
  }

  const resolution = resolutionOf(receipt);
  if (resolution !== "blocked") return { receipt, resolution, integration };
  const blockedReason = integration.outcome === "blocked"
    ? integration.reason
    : `receipt-${receipt.state}-cannot-reach-${integration.outcome}`;
  return { receipt, resolution, integration, blockedReason };
}
