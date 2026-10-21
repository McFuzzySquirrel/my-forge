import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { sha256Digest } from "../../contract/v1/index.ts";
import { PostgresRunStatusStore } from "../../storage/index.ts";
import type { SqlQueryable } from "../../storage/postgres/operation-receipts.ts";
import type { TransactionalSqlDatabase } from "../../storage/postgres/repository-integration.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

test("run status validates registration and event identities before database access", async () => {
  const query: SqlQueryable["query"] = async () => {
    throw new Error("Database must not be reached for invalid status input");
  };
  const database: TransactionalSqlDatabase & SqlQueryable = {
    query,
    async connect() {
      return { query, release() {} };
    },
  };
  const store = new PostgresRunStatusStore(database);
  await assert.rejects(store.createRun({
    schemaVersion: 1,
    runId: "run-invalid",
    repositoryId: "repo-1",
    targetRef: "refs/heads/main",
    manifestDigest: sha256Digest("manifest"),
    taskIds: ["duplicate", "duplicate"],
  }), /unique non-empty task IDs/);
  await assert.rejects(store.appendEvent({
    schemaVersion: 1,
    runId: "run-invalid",
    eventKey: "not allowed",
    eventType: "run.started",
    runStatus: "running",
  }), /event key/);
});

test("PostgreSQL run status is authoritative, sequenced, idempotent, and reconnectable", {
  skip: !connectionString,
}, async () => {
  const schema = `p4_status_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const name of ["run-status.sql", "run-definition-versions.sql"]) {
      await database.query(await readFile(new URL(`../../storage/postgres/${name}`, import.meta.url), "utf8"));
    }

    const store = new PostgresRunStatusStore(database);
    const run = {
      schemaVersion: 1 as const,
      runId: "run-status-1",
      repositoryId: "repo-1",
      targetRef: "refs/heads/main",
      manifestDigest: sha256Digest("manifest"),
      taskIds: ["task-b", "task-a"],
    };
    assert.deepEqual(await store.createRun(run), { runId: run.runId, reused: false });
    assert.deepEqual(await store.createRun(run), { runId: run.runId, reused: true });
    await assert.rejects(store.createRun({ ...run, taskIds: ["task-a", "task-b"] }), /conflicts/);

    const started = await store.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      eventKey: "run.started",
      eventType: "run.started",
      runStatus: "running",
    });
    assert.equal(started.event.sequence, 2);

    const attemptStarted = {
      schemaVersion: 1 as const,
      runId: run.runId,
      eventKey: "attempt:task-b:1:started",
      eventType: "attempt.started" as const,
      taskId: "task-b",
      logicalAttempt: 1,
      taskStatus: "running" as const,
      attemptStatus: "running" as const,
    };
    const firstAttempt = await store.appendEvent(attemptStarted);
    const redelivery = await store.appendEvent(attemptStarted);
    assert.equal(firstAttempt.event.sequence, 3);
    assert.equal(redelivery.event.sequence, 3);
    assert.equal(redelivery.reused, true);
    await assert.rejects(
      store.appendEvent({ ...attemptStarted, taskStatus: "ready" }),
      /conflicts/,
    );

    await store.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      eventKey: "attempt:task-b:1:waiting",
      eventType: "attempt.waiting-for-approval",
      taskId: "task-b",
      logicalAttempt: 1,
      taskStatus: "waiting-for-approval",
      attemptStatus: "waiting-for-approval",
    });
    await store.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      eventKey: "attempt:task-b:1:resumed",
      eventType: "attempt.resumed",
      taskId: "task-b",
      logicalAttempt: 1,
      taskStatus: "running",
      attemptStatus: "running",
    });
    await store.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      eventKey: "attempt:task-b:1:complete",
      eventType: "task.completed",
      taskId: "task-b",
      logicalAttempt: 1,
      taskStatus: "complete",
      attemptStatus: "complete",
      detail: { evidence: "sha256:verified" },
    });
    await store.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      eventKey: "run.complete",
      eventType: "run.completed",
      runStatus: "complete",
    });

    const snapshot = await store.getRunStatus(run.runId);
    assert.equal(snapshot?.status, "complete");
    assert.equal(snapshot?.revision, 7);
    assert.deepEqual(snapshot?.tasks.map((task) => task.taskId), ["task-b", "task-a"]);
    assert.equal(snapshot?.tasks[0]?.status, "complete");
    assert.equal(snapshot?.tasks[0]?.attempts[0]?.status, "complete");
    assert.equal(snapshot?.tasks[1]?.status, "pending");
    const taskResponse = await store.getTaskStatus(run.runId, "task-b");
    assert.equal(taskResponse?.run.revision, 7);
    assert.equal(taskResponse?.task.status, "complete");
    const attemptResponse = await store.getTaskAttempt(run.runId, "task-b", 1);
    assert.equal(attemptResponse?.run.manifestDigest, run.manifestDigest);
    assert.equal(attemptResponse?.attempt.status, "complete");

    const firstPage = await store.listEvents(run.runId, 0, 3);
    assert.deepEqual(firstPage.events.map((event) => event.sequence), [1, 2, 3]);
    assert.equal(firstPage.cursor, 3);
    assert.equal(firstPage.hasMore, true);
    const secondPage = await store.listEvents(run.runId, firstPage.cursor, 10);
    assert.deepEqual(secondPage.events.map((event) => event.sequence), [4, 5, 6, 7]);
    assert.equal(secondPage.hasMore, false);

    const controller = new AbortController();
    const watcher = store.watchEvents(run.runId, 6, {
      signal: controller.signal,
      pollIntervalMs: 50,
    });
    assert.equal((await watcher.next()).value?.sequence, 7);
    controller.abort();
    assert.equal((await watcher.next()).done, true);

    await database.end();
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const recovered = new PostgresRunStatusStore(database);
    assert.equal((await recovered.getRunStatus(run.runId))?.revision, 7);
    assert.equal((await recovered.listEvents(run.runId, 6)).events[0]?.eventKey, "run.complete");
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

test("PostgreSQL run status keeps cancellation authoritative when task failures race it", {
  skip: !connectionString,
}, async () => {
  const schema = `p6_cancel_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const name of ["run-status.sql", "run-definition-versions.sql"]) {
      await database.query(await readFile(new URL(`../../storage/postgres/${name}`, import.meta.url), "utf8"));
    }
    const store = new PostgresRunStatusStore(database);
    const runId = "run-cancel-race";
    await store.createRun({
      schemaVersion: 1,
      runId,
      repositoryId: "repo-1",
      targetRef: "refs/heads/main",
      manifestDigest: sha256Digest("manifest"),
      taskIds: ["fails-first", "cancelled-first"],
    });
    const append = (eventKey: string, fields: Record<string, unknown>) => store.appendEvent({
      schemaVersion: 1, runId, eventKey, ...fields,
    } as Parameters<typeof store.appendEvent>[0]);
    await append("run.started", { eventType: "run.started", runStatus: "running" });
    for (const taskId of ["fails-first", "cancelled-first"]) {
      await append(`attempt:${taskId}:1:started`, {
        eventType: "attempt.started", taskId, logicalAttempt: 1, taskStatus: "running", attemptStatus: "running",
      });
    }
    await append("run.cancelling", { eventType: "run.cancelling", runStatus: "cancelling" });
    assert.deepEqual(await store.listActiveRunIds(), [runId]);

    await append("task:fails-first:failed", {
      eventType: "task.failed", taskId: "fails-first", logicalAttempt: 1, taskStatus: "failed", attemptStatus: "failed",
    });
    await append("task:fails-first:cancelled", { eventType: "task.cancelled", taskId: "fails-first", taskStatus: "cancelled" });

    await append("task:cancelled-first:cancelled", {
      eventType: "task.cancelled", taskId: "cancelled-first", taskStatus: "cancelled",
    });
    await append("run.cancelled", { eventType: "run.cancelled", runStatus: "cancelled" });
    await append("task:cancelled-first:failed", {
      eventType: "task.failed", taskId: "cancelled-first", logicalAttempt: 1, taskStatus: "failed", attemptStatus: "failed",
    });

    assert.deepEqual(await store.listActiveRunIds(), []);
    await append("attempt:cancelled-first:2:started", {
      eventType: "attempt.started", taskId: "cancelled-first", logicalAttempt: 2, taskStatus: "running", attemptStatus: "running",
    });
    const snapshot = await store.getRunStatus(runId);
    assert.equal(snapshot?.status, "cancelled");
    assert.deepEqual(snapshot?.tasks.map((task) => [task.taskId, task.status]), [
      ["fails-first", "cancelled"],
      ["cancelled-first", "cancelled"],
    ]);
    const events = await store.listEvents(runId, 0, 50);
    assert.deepEqual(events.events.slice(-2).map((event) => event.eventType), ["task.failed", "attempt.started"]);
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
