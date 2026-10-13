import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { sha256Digest, type OperationKeyV1 } from "../../contract/v1/index.ts";
import { PostgresOperationReceiptStore } from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

test("PostgreSQL receipts survive pool restart and concurrent claims/transitions use CAS", {
  skip: !connectionString,
}, async () => {
  const schema = `p3_receipts_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const migration = await readFile(
      new URL("../../storage/postgres/operation-receipts.sql", import.meta.url),
      "utf8",
    );
    await database.query(migration);

    const store = new PostgresOperationReceiptStore(database);
    const operation: OperationKeyV1 = {
      runId: "integration-run",
      taskId: "task-a",
      logicalAttempt: 1,
      operationId: "operation-a",
    };
    const claims = await Promise.all([store.claim(operation), store.claim(operation)]);
    assert.equal(claims.filter((result) => result.ok && !result.reused).length, 1);
    assert.equal(claims.filter((result) => result.ok && result.reused).length, 1);
    assert.equal((await store.get(operation))?.recordVersion, 1);

    assert.ok((await store.transition(operation, 1, "executing")).ok);
    const effectDigest = sha256Digest("persisted patch");
    assert.ok((await store.transition(operation, 2, "effect-published", { effectDigest })).ok);
    assert.ok((await store.transition(operation, 3, "accepted", { effectDigest })).ok);

    const interrupted: OperationKeyV1 = { ...operation, operationId: "operation-interrupted" };
    assert.ok((await store.claim(interrupted)).ok);
    assert.ok((await store.transition(interrupted, 1, "executing")).ok);
    const contenders = await Promise.all([
      store.transition(interrupted, 2, "failed"),
      store.transition(interrupted, 2, "ambiguous", { diagnosticRef: "diag://worker-lost" }),
    ]);
    assert.equal(contenders.filter((result) => result.ok).length, 1);
    assert.equal(contenders.filter((result) => !result.ok && result.code === "stale-revision").length, 1);

    const recoverable: OperationKeyV1 = { ...operation, operationId: "operation-recoverable" };
    assert.ok((await store.claim(recoverable)).ok);
    assert.ok((await store.transition(recoverable, 1, "executing")).ok);
    assert.ok((await store.transition(recoverable, 2, "ambiguous", { diagnosticRef: "diag://restart" })).ok);

    await database.end();
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const recovered = new PostgresOperationReceiptStore(database);
    assert.equal((await recovered.get(operation))?.state, "accepted");
    const candidates = await recovered.listReconciliationCandidates();
    assert.ok(candidates.some((candidate) => candidate.key.operationId === recoverable.operationId));
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
