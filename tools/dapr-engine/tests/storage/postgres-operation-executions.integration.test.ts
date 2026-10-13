import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { sha256Digest, type ExecutionClaimV1, type OperationKeyV1 } from "../../contract/v1/index.ts";
import { superviseExecution } from "../../execution/index.ts";
import { PostgresExecutionOwnershipStore, PostgresOperationReceiptStore } from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;
const TTL_MS = 300;

async function migrate(database: Pool): Promise<void> {
  for (const file of ["operation-receipts.sql", "operation-executions.sql"]) {
    await database.query(await readFile(new URL(`../../storage/postgres/${file}`, import.meta.url), "utf8"));
  }
}

test("PostgreSQL execution ownership fences takeover, cancellation, and late outcomes", {
  skip: !connectionString,
}, async () => {
  const schema = `p3_executions_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(database);

    const receipts = new PostgresOperationReceiptStore(database);
    const executions = new PostgresExecutionOwnershipStore(database);
    const executing = async (operationId: string): Promise<OperationKeyV1> => {
      const key: OperationKeyV1 = { runId: "integration-run", taskId: "task-a", logicalAttempt: 1, operationId };
      assert.ok((await receipts.claim(key)).ok);
      assert.ok((await receipts.transition(key, 1, "executing")).ok);
      return key;
    };
    const claimOf = (result: Awaited<ReturnType<typeof executions.start>>): ExecutionClaimV1 => {
      assert.ok(result.ok, JSON.stringify(result));
      return { executionEpoch: result.execution.executionEpoch, workerId: result.execution.workerId };
    };

    // A receipt that is not executing cannot be started.
    const claimedOnly: OperationKeyV1 = { runId: "integration-run", taskId: "task-a", logicalAttempt: 1, operationId: "claimed" };
    assert.ok((await receipts.claim(claimedOnly)).ok);
    assert.deepEqual(
      await executions.start({ key: claimedOnly, workerId: "w1", budgetMs: 60_000, heartbeatTtlMs: TTL_MS }),
      { ok: false, code: "receipt-not-executing" },
    );

    // Concurrent first starts: exactly one owner, the other sees it held.
    const takeover = await executing("takeover");
    const starts = await Promise.all([
      executions.start({ key: takeover, workerId: "w1", budgetMs: 60_000, heartbeatTtlMs: TTL_MS }),
      executions.start({ key: takeover, workerId: "w2", budgetMs: 60_000, heartbeatTtlMs: TTL_MS }),
    ]);
    assert.equal(starts.filter((result) => result.ok).length, 1);
    assert.equal(starts.filter((result) => !result.ok && result.code === "execution-held").length, 1);
    const first = claimOf(starts.find((result) => result.ok)!);
    const original = await executions.get(takeover);
    assert.equal(original?.executionEpoch, 1);

    // Worker loss: the heartbeat lapses, fencing marks it lost, redelivery takes over.
    await delay(TTL_MS + 100);
    assert.deepEqual(await executions.heartbeat(takeover, first, TTL_MS), { ok: false, code: "execution-expired" });
    const fenced = await executions.fenceLostExecutions();
    assert.deepEqual(fenced.map((lost) => [lost.execution.key.operationId, lost.receiptFailed]), [["takeover", false]]);
    const second = claimOf(await executions.start({ key: takeover, workerId: "w3", budgetMs: 1, heartbeatTtlMs: TTL_MS }));
    const current = await executions.get(takeover);
    assert.equal(second.executionEpoch, 2);
    assert.equal(current?.deadlineAt, original?.deadlineAt);
    assert.deepEqual(current?.lostEpochs, [1]);

    assert.deepEqual(await executions.recordExit(takeover, first, { status: 0, cleanup: "observed" }), {
      ok: false, code: "stale-execution",
    });
    assert.deepEqual(
      await executions.publishOutcome(takeover, first, { expectedReceiptVersion: 2, to: "effect-published", effectDigest: sha256Digest("stale") }),
      { ok: false, code: "stale-execution" },
    );
    assert.equal((await receipts.get(takeover))?.state, "executing");

    // Publication before exit is rejected; after exit it commits with the receipt.
    const effectDigest = sha256Digest("patch");
    assert.deepEqual(
      await executions.publishOutcome(takeover, second, { expectedReceiptVersion: 2, to: "effect-published", effectDigest }),
      { ok: false, code: "process-running" },
    );
    assert.ok((await executions.recordExit(takeover, second, { status: 0, cleanup: "observed" })).ok);
    const published = await executions.publishOutcome(takeover, second, { expectedReceiptVersion: 2, to: "effect-published", effectDigest });
    assert.ok(published.ok, JSON.stringify(published));
    assert.equal((await receipts.get(takeover))?.state, "effect-published");
    assert.deepEqual(await executions.requestCancel(takeover, "operator"), { ok: false, code: "outcome-published" });
    assert.equal(
      (await executions.start({ key: takeover, workerId: "w4", budgetMs: 60_000, heartbeatTtlMs: TTL_MS })).ok,
      false,
    );

    // A cancel serialized before publication wins: the result is late and the receipt fails.
    const cancelled = await executing("cancel-race");
    const owner = claimOf(await executions.start({ key: cancelled, workerId: "w1", budgetMs: 60_000, heartbeatTtlMs: TTL_MS }));
    assert.ok((await executions.requestCancel(cancelled, "operator")).ok);
    const heartbeat = await executions.heartbeat(cancelled, owner, TTL_MS);
    assert.ok(heartbeat.ok && heartbeat.directive === "cancel");
    assert.ok((await executions.recordExit(cancelled, owner, { status: null, stopReason: "cancel", cleanup: "observed" })).ok);
    assert.deepEqual(
      await executions.publishOutcome(cancelled, owner, {
        expectedReceiptVersion: 2, to: "effect-published", effectDigest, diagnosticRef: "diag://cancelled-output",
      }),
      { ok: false, code: "late-result", receiptFailed: true },
    );
    const failedReceipt = await receipts.get(cancelled);
    assert.equal(failedReceipt?.state, "failed");
    assert.ok(failedReceipt?.diagnosticRefs.includes("diag://cancelled-output"));

    // A cancelled owner that disappears fails its receipt with unconfirmed cleanup.
    const abandoned = await executing("cancel-lost");
    claimOf(await executions.start({ key: abandoned, workerId: "w1", budgetMs: 60_000, heartbeatTtlMs: TTL_MS }));
    assert.ok((await executions.requestCancel(abandoned, "operator")).ok);
    await delay(TTL_MS + 100);
    const lost = await executions.fenceLostExecutions();
    assert.deepEqual(lost.map((entry) => [entry.execution.key.operationId, entry.receiptFailed]), [["cancel-lost", true]]);
    assert.ok((await receipts.get(abandoned))?.diagnosticRefs.some((ref) => ref.includes("cleanup-unconfirmed")));

    // The supervisor drives the durable store end to end.
    const supervisedKey = await executing("supervised");
    const supervised = await superviseExecution({
      store: executions,
      key: supervisedKey,
      workerId: "w5",
      budgetMs: 60_000,
      heartbeatIntervalMs: 50,
      heartbeatTtlMs: TTL_MS,
      run: async ({ onProcessSettled }) => {
        await delay(150);
        onProcessSettled("observed");
        return 0;
      },
      exitStatus: (status) => status,
    });
    assert.ok(supervised.started);
    assert.equal(supervised.execution?.state, "exited");
    assert.equal(supervised.execution?.exit?.cleanup, "observed");

    // State survives a pool restart.
    await database.end();
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const recovered = new PostgresExecutionOwnershipStore(database);
    assert.equal((await recovered.get(takeover))?.state, "published");
    assert.equal((await recovered.get(abandoned))?.state, "lost");
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
