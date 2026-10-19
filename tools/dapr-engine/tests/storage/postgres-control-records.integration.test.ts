import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  authorizeTaskApproval,
  sha256Digest,
  type ControlRequestV1,
} from "../../contract/v1/index.ts";
import { PostgresControlRecordStore } from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

test("PostgreSQL controls deduplicate requests, CAS transitions, and retain approval bindings", {
  skip: !connectionString,
}, async () => {
  const schema = `p4_controls_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const migration = await readFile(
      new URL("../../storage/postgres/control-records.sql", import.meta.url),
      "utf8",
    );
    await database.query(migration);

    const store = new PostgresControlRecordStore(database);
    const request: ControlRequestV1 = {
      schemaVersion: 1,
      controlId: randomUUID(),
      runId: "run-controls",
      action: "approve-task",
      payload: {
        taskId: "task-a",
        evidenceDigests: [sha256Digest("evidence")],
      },
    };
    const operator = { subject: "operator:42", roles: ["operator"] };
    const [first, retried] = await Promise.all([
      store.request(request, operator),
      store.request(request, operator),
    ]);
    assert.ok(first.ok && retried.ok);
    assert.equal([first, retried].filter((result) => !result.reused).length, 1);
    assert.equal([first, retried].filter((result) => result.reused).length, 1);
    const conflicted = await store.request({ ...request, payload: { taskId: "task-b" } }, operator);
    assert.deepEqual(conflicted, { ok: false, code: "control-conflict" });

    const bindingResult = authorizeTaskApproval(request, operator, {
      runId: request.runId,
      manifestDigest: sha256Digest("manifest"),
      taskId: "task-a",
      logicalAttempt: 3,
      taskWorkflowInstanceId: "forge-task-attempt-3",
      taskStatus: "waiting-for-approval",
      evidenceDigests: [sha256Digest("evidence")],
    });
    assert.ok(bindingResult.ok);
    const accepted = await store.transition(request.controlId, 1, "accepted", {
      approvalBinding: bindingResult.binding,
    });
    assert.ok(accepted.ok);
    await assert.rejects(
      database.query(
        `UPDATE forge_control_records
         SET approval_binding = approval_binding - 'taskWorkflowInstanceId'
         WHERE control_id = $1`,
        [request.controlId],
      ),
      /check constraint/,
    );
    const applied = await store.transition(request.controlId, 2, "applied", {
      approvalBinding: bindingResult.binding,
    });
    assert.ok(applied.ok);
    assert.equal(applied.record.recordVersion, 3);
    assert.deepEqual(await store.getApproval(request.runId, "task-a", 3), bindingResult.binding);
    assert.equal(await store.getApproval(request.runId, "task-a", 2), undefined);

    const runControl = (action: "pause" | "replay-task"): ControlRequestV1 => ({
      schemaVersion: 1,
      controlId: randomUUID(),
      runId: request.runId,
      action,
      payload: action === "replay-task" ? { taskId: "task-a" } : {},
    });
    const pause = runControl("pause");
    const replay = runControl("replay-task");
    const requestedOnly = runControl("pause");
    for (const control of [pause, replay, requestedOnly]) assert.ok((await store.request(control)).ok);
    assert.ok((await store.transition(pause.controlId, 1, "accepted")).ok);
    assert.ok((await store.transition(replay.controlId, 1, "accepted")).ok);
    assert.deepEqual(
      (await store.listAccepted(request.runId, 64)).map((record) => record.controlId).sort(),
      [pause.controlId, replay.controlId].sort(),
    );
    assert.equal((await store.listAccepted(request.runId, 1)).length, 1);
    assert.ok((await store.transition(pause.controlId, 2, "applied")).ok);
    assert.deepEqual((await store.listAccepted(request.runId, 64)).map((record) => record.controlId), [replay.controlId]);
    await assert.rejects(store.listAccepted(request.runId, 0), /limit/);

    const stale = await store.transition(request.controlId, 2, "rejected", {
      reasonCode: "stale-evidence",
    });
    assert.deepEqual(stale, { ok: false, code: "stale-revision" });

    await database.end();
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const recovered = new PostgresControlRecordStore(database);
    const persisted = await recovered.get(request.controlId);
    assert.equal(persisted?.state, "applied");
    assert.deepEqual(persisted?.approvalBinding, bindingResult.binding);
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
