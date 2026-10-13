import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA_VERSION, sha256Digest, type OperationReceiptV1, type ReceiptState } from "../../contract/v1/index.ts";
import {
  reconcileIntegrationReceipt,
  type ReceiptStoreResult,
  type RepositoryIntegrationReconciliation,
} from "../../storage/index.ts";

const scope = {
  repositoryId: "repo_fixture",
  targetRef: "refs/heads/main",
  runId: "run_a",
  taskId: "task_a",
  logicalAttempt: 1,
  operationId: "operation_a",
};
const effectDigest = sha256Digest("effect");
const integrated: RepositoryIntegrationReconciliation = {
  outcome: "integrated",
  commitSha: "a".repeat(40),
  checkpointDigest: sha256Digest("checkpoint"),
  effectDigest,
  recordedBy: "reconciliation",
  backfilled: true,
};

function receipt(state: ReceiptState, overrides: Partial<OperationReceiptV1> = {}): OperationReceiptV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    key: { runId: scope.runId, taskId: scope.taskId, logicalAttempt: 1, operationId: scope.operationId },
    state,
    recordVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    diagnosticRefs: [],
    ...overrides,
  };
}

/** A receipt port whose transitions are scripted, recording what was attempted. */
function receiptPort(initial: OperationReceiptV1, script: Array<ReceiptStoreResult | "apply"> = []) {
  let current = initial;
  const attempts: string[] = [];
  return {
    attempts,
    get current() { return current; },
    port: {
      get: async () => current,
      transition: async (
        _key: unknown,
        version: number,
        to: ReceiptState,
        options: { effectDigest?: typeof effectDigest; diagnosticRef?: string } = {},
      ): Promise<ReceiptStoreResult> => {
        attempts.push(`${current.state}@${version}->${to}`);
        const scripted = script.shift() ?? "apply";
        if (scripted !== "apply") return scripted;
        current = {
          ...current,
          state: to,
          recordVersion: current.recordVersion + 1,
          ...(options.effectDigest ? { effectDigest: options.effectDigest } : {}),
          diagnosticRefs: options.diagnosticRef ? [...current.diagnosticRefs, options.diagnosticRef] : current.diagnosticRefs,
        };
        return { ok: true, receipt: current, reused: false };
      },
    },
  };
}

function authority(result: RepositoryIntegrationReconciliation) {
  let calls = 0;
  return {
    get calls() { return calls; },
    port: { reconcile: async () => { calls += 1; return result; } },
  };
}

test("a terminal receipt is returned without consulting Git", async () => {
  const receipts = receiptPort(receipt("accepted", { effectDigest }));
  const git = authority(integrated);
  const result = await reconcileIntegrationReceipt(receipts.port, git.port, scope);
  assert.equal(result.resolution, "accepted");
  assert.equal(result.integration, undefined);
  assert.equal(git.calls, 0);
});

test("a stale revision is re-read and reconciliation continues from the newer state", async () => {
  const receipts = receiptPort(receipt("executing"), [{ ok: false, code: "stale-revision" }]);
  const result = await reconcileIntegrationReceipt(receipts.port, authority(integrated).port, scope);
  assert.equal(result.resolution, "accepted");
  assert.deepEqual(receipts.attempts, [
    "executing@1->effect-published",
    "executing@1->effect-published",
    "effect-published@2->accepted",
  ]);
  assert.equal(result.receipt.effectDigest, effectDigest);
});

test("a receipt that published a different effect is blocked, not accepted", async () => {
  const receipts = receiptPort(receipt("effect-published", { effectDigest: sha256Digest("other") }), [
    { ok: false, code: "conflicting-effect" },
  ]);
  const result = await reconcileIntegrationReceipt(receipts.port, authority(integrated).port, scope);
  assert.equal(result.resolution, "blocked");
  assert.equal(result.blockedReason, "conflicting-effect");
  assert.equal(result.receipt.state, "effect-published");
});

test("a published effect that Git does not show is left blocked for operator review", async () => {
  const receipts = receiptPort(receipt("effect-published", { effectDigest }));
  const result = await reconcileIntegrationReceipt(
    receipts.port,
    authority({ outcome: "not-integrated", reason: "commit-not-on-target" }).port,
    scope,
  );
  assert.equal(result.resolution, "blocked");
  assert.equal(result.blockedReason, "receipt-effect-published-cannot-reach-not-integrated");
  assert.deepEqual(receipts.attempts, []);
});

test("a blocked integration moves an executing receipt to ambiguous and keeps an ambiguous one there", async () => {
  const blocked: RepositoryIntegrationReconciliation = { outcome: "blocked", reason: "checkpoint-unavailable" };
  const executing = receiptPort(receipt("executing"));
  const first = await reconcileIntegrationReceipt(executing.port, authority(blocked).port, scope);
  assert.equal(first.receipt.state, "ambiguous");
  assert.deepEqual(first.receipt.diagnosticRefs, ["git-integration:blocked:checkpoint-unavailable"]);

  const again = await reconcileIntegrationReceipt(executing.port, authority(blocked).port, scope);
  assert.equal(again.resolution, "blocked");
  assert.equal(again.receipt.recordVersion, first.receipt.recordVersion);
});

test("an unexpected receipt store failure is surfaced", async () => {
  const receipts = receiptPort(receipt("executing"), [{ ok: false, code: "invalid-transition" }]);
  await assert.rejects(
    reconcileIntegrationReceipt(receipts.port, authority(integrated).port, scope),
    /executing -> effect-published failed: invalid-transition/,
  );
});
