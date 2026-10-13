import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest, type OperationKeyV1, type OperationReceiptV1 } from "../../contract/v1/index.ts";
import {
  MAX_DIAGNOSTIC_REFERENCES,
  PostgresOperationReceiptStore,
  type SqlQueryResult,
  type SqlQueryable,
} from "../../storage/index.ts";

const key: OperationKeyV1 = {
  runId: "run-a",
  taskId: "task-a",
  logicalAttempt: 1,
  operationId: "operation-a",
};

function receipt(
  state: OperationReceiptV1["state"] = "claimed",
  recordVersion = 1,
  effectDigest: string | null = null,
  diagnosticRefs: string[] = [],
): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: key.runId,
    task_id: key.taskId,
    logical_attempt: key.logicalAttempt,
    operation_id: key.operationId,
    state,
    record_version: recordVersion,
    effect_digest: effectDigest,
    created_at: new Date("2026-10-13T12:00:00.000Z"),
    updated_at: new Date("2026-10-13T12:00:00.000Z"),
    diagnostic_refs: diagnosticRefs,
  };
}

class ScriptedDatabase implements SqlQueryable {
  readonly calls: { readonly text: string; readonly values: unknown[] }[] = [];
  private readonly results: Record<string, unknown>[][] = [];

  respondWith(...rows: Record<string, unknown>[]): void {
    this.results.push(rows);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return { rows: (this.results.shift() ?? []) as Row[] };
  }
}

test("claim creates a version-1 receipt and duplicate delivery reuses its durable row", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  database.respondWith(receipt());
  const created = await store.claim(key);
  assert.ok(created.ok && !created.reused);
  assert.equal(created.receipt.state, "claimed");
  assert.equal(created.receipt.recordVersion, 1);

  database.respondWith();
  database.respondWith(receipt("executing", 2));
  const reused = await store.claim(key);
  assert.ok(reused.ok && reused.reused);
  assert.equal(reused.receipt.state, "executing");
  assert.match(database.calls[1]!.text, /ON CONFLICT .* DO NOTHING/s);
});

test("transitions persist with a version-and-state compare-and-set and preserve the effect digest", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  const effectDigest = sha256Digest("published patch");
  database.respondWith(receipt("executing", 2));
  database.respondWith(receipt("effect-published", 3, effectDigest));

  const result = await store.transition(key, 2, "effect-published", { effectDigest });
  assert.ok(result.ok);
  assert.equal(result.receipt.recordVersion, 3);
  assert.equal(result.receipt.effectDigest, effectDigest);
  const update = database.calls[1]!;
  assert.match(update.text, /record_version = \$8 AND state = \$9/);
  assert.equal(update.values[7], 2);
  assert.equal(update.values[8], "executing");
});

test("stale, invalid, and conflicting transitions fail without issuing an update", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  database.respondWith(receipt("executing", 4));
  assert.deepEqual(await store.transition(key, 3, "failed"), { ok: false, code: "stale-revision" });

  database.respondWith(receipt("executing", 4));
  assert.deepEqual(await store.transition(key, 4, "accepted"), { ok: false, code: "invalid-transition" });

  database.respondWith(receipt("effect-published", 5, sha256Digest("effect A")));
  assert.deepEqual(
    await store.transition(key, 5, "accepted", { effectDigest: sha256Digest("effect B") }),
    { ok: false, code: "conflicting-effect" },
  );
  assert.equal(database.calls.length, 3);
});

test("a concurrent transition that wins the compare-and-set makes this transition stale", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  database.respondWith(receipt("executing", 2));
  database.respondWith();
  database.respondWith(receipt("ambiguous", 3));

  assert.deepEqual(await store.transition(key, 2, "failed"), { ok: false, code: "stale-revision" });
  assert.match(database.calls[1]!.text, /record_version = \$8 AND state = \$9/);
});

test("ambiguous and other incomplete receipts are returned for external reconciliation", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  database.respondWith(receipt("ambiguous", 3, null, ["diag://worker-lost"]));
  const candidates = await store.listReconciliationCandidates(50);
  assert.equal(candidates[0]?.state, "ambiguous");
  assert.deepEqual(candidates[0]?.diagnosticRefs, ["diag://worker-lost"]);
  assert.match(database.calls[0]!.text, /state IN \('claimed', 'executing', 'effect-published', 'ambiguous'\)/);
  assert.deepEqual(database.calls[0]!.values, [50]);
});

test("receipt diagnostics are bounded and invalid candidate limits are rejected", async () => {
  const database = new ScriptedDatabase();
  const store = new PostgresOperationReceiptStore(database);
  database.respondWith(receipt("executing", 2, null, Array.from({ length: MAX_DIAGNOSTIC_REFERENCES }, (_, i) => `diag://${i}`)));
  assert.deepEqual(
    await store.transition(key, 2, "ambiguous", { diagnosticRef: "diag://overflow" }),
    { ok: false, code: "too-many-diagnostic-refs" },
  );
  await assert.rejects(() => store.listReconciliationCandidates(0), RangeError);
  assert.equal(database.calls.length, 1);
});
