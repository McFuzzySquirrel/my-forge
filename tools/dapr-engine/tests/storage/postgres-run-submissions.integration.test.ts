import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { Sha256Digest } from "../../contract/v1/index.ts";
import { migrateApplicationDatabase } from "../../service/migrations.ts";
import { PostgresRunSubmissionStore, type StoredRunSubmissionV1 } from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;
const digest = (fill: string) => `sha256:${fill.repeat(64)}` as Sha256Digest;
const runId = (fill: string) => `run_${fill.repeat(32)}`;
const submission = (submissionKey: string, repositoryId = "demo") =>
  ({ schemaVersion: 1, submissionKey, repositoryId }) as unknown as StoredRunSubmissionV1["submission"];

test("PostgreSQL run submissions are idempotent and allocate replay attempts once per control", {
  skip: !connectionString,
}, async () => {
  const schema = `p5_submissions_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrateApplicationDatabase(database);
    const store = new PostgresRunSubmissionStore(database);

    const created = await store.create({ runId: runId("a"), snapshotDigest: digest("1"), submission: submission("key-a") });
    assert.ok(created.ok && !created.reused);
    const reused = await store.create({ runId: runId("b"), snapshotDigest: digest("1"), submission: submission("key-a") });
    assert.ok(reused.ok && reused.reused);
    assert.equal(reused.record.runId, runId("a"));
    assert.deepEqual(
      await store.create({ runId: runId("c"), snapshotDigest: digest("2"), submission: submission("key-a") }),
      { ok: false, code: "submission-conflict" },
    );
    await store.create({ runId: runId("d"), snapshotDigest: digest("3"), submission: submission("key-d", "other") });

    assert.equal((await store.get(runId("a")))?.submission.submissionKey, "key-a");
    assert.equal(await store.get("not-a-run"), undefined);
    assert.deepEqual((await store.list(10)).map((record) => record.runId).sort(), [runId("a"), runId("d")]);
    assert.deepEqual((await store.list(10, "other")).map((record) => record.runId), [runId("d")]);

    const first = randomUUID();
    assert.equal(await store.allocateReplayAttempt(first, runId("a"), "T1"), 2);
    assert.equal(await store.allocateReplayAttempt(first, runId("a"), "T1"), 2);
    assert.equal(await store.allocateReplayAttempt(randomUUID(), runId("a"), "T1"), 3);
    assert.equal(await store.allocateReplayAttempt(randomUUID(), runId("a"), "T2"), 2);
  } finally {
    await database?.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
