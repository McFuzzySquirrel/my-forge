import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import type { HarnessRunnerRequestV1 } from "../../execution/runner-contract.ts";
import { PostgresHostRunnerJobStore } from "../../storage/postgres/host-runner-jobs.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

function request(repositoryId: string, operationId = randomUUID()): HarnessRunnerRequestV1 {
  const task = manifestTask({ id: "T1", ownerAgent: "builder" });
  return {
    schemaVersion: 1,
    identity: {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      taskId: task.id,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      logicalAttempt: 1,
      operationId,
    },
    repositoryId,
    baseRevision: "a".repeat(40),
    harness: "stub",
    agent: agent("builder"),
    task,
    contextBlock: "",
    requiredCapabilities: ["repository-tools"],
    timeoutMs: 10_000,
    instructions: "Complete the task.",
  };
}

test("PostgreSQL host-runner queue is durable, repository-scoped, leased, and cancellable", {
  skip: !connectionString,
}, async () => {
  const schema = `host_runner_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await database.query(await readFile(
      new URL("../../storage/postgres/host-runner-jobs.sql", import.meta.url),
      "utf8",
    ));
    await database.query(await readFile(
      new URL("../../storage/postgres/host-runner-job-summaries.sql", import.meta.url),
      "utf8",
    ));
    const store = new PostgresHostRunnerJobStore(database);

    const job = request("repo_test");
    assert.deepEqual(await store.enqueue(job), { ok: true, reused: false });
    assert.deepEqual(await store.enqueue(job), { ok: true, reused: true });
    assert.deepEqual(await store.enqueue({ ...job, instructions: "conflicting request" }), {
      ok: false,
      code: "request-conflict",
    });

    const otherRepositoryJob = request("repo_other");
    assert.deepEqual(await store.enqueue(otherRepositoryJob), { ok: true, reused: false });
    const [claim, concurrentClaim] = await Promise.all([
      store.claim("repo_test", 5_000),
      store.claim("repo_test", 5_000),
    ]);
    assert.ok(claim);
    assert.equal(concurrentClaim, undefined);
    assert.equal(claim.request.identity.operationId, job.identity.operationId);
    assert.equal(await store.getForRunner(job.identity.operationId, "repo_other", claim.leaseId), undefined);
    assert.equal(await store.heartbeat(job.identity.operationId, claim.leaseId, 5_000), true);

    const cancelled = request("repo_test");
    assert.deepEqual(await store.enqueue(cancelled), { ok: true, reused: false });
    const cancelClaim = await store.claim("repo_test", 5_000);
    assert.ok(cancelClaim);
    assert.equal(cancelClaim.request.identity.operationId, cancelled.identity.operationId);
    assert.equal(await store.cancel(cancelled.identity.operationId), true);
    assert.equal(
      (await store.getForRunner(cancelled.identity.operationId, "repo_test", cancelClaim.leaseId))?.cancelRequested,
      true,
    );
    assert.equal(await store.complete(cancelled.identity.operationId, cancelClaim.leaseId, { accepted: true }), false);
    assert.equal((await store.get(cancelled.identity.operationId))?.state, "cancelled");

    const expiring = request("repo_test");
    assert.deepEqual(await store.enqueue(expiring), { ok: true, reused: false });
    const originalLease = await store.claim("repo_test", 1_000);
    assert.ok(originalLease);
    await delay(1_200);
    const replacementLease = await store.claim("repo_test", 5_000);
    assert.ok(replacementLease);
    assert.equal(replacementLease.request.identity.operationId, expiring.identity.operationId);
    assert.notEqual(replacementLease.leaseId, originalLease.leaseId);
    assert.equal(await store.heartbeat(expiring.identity.operationId, originalLease.leaseId, 5_000), false);
    assert.equal(await store.complete(expiring.identity.operationId, replacementLease.leaseId, { accepted: true }), true);
    assert.equal((await store.get(expiring.identity.operationId))?.state, "completed");

    const foreignClaim = await store.claim("repo_other", 5_000);
    assert.ok(foreignClaim);
    assert.equal(foreignClaim.request.identity.operationId, otherRepositoryJob.identity.operationId);
    assert.equal(await store.fail(otherRepositoryJob.identity.operationId, foreignClaim.leaseId, "test failure"), true);
    assert.equal((await store.get(otherRepositoryJob.identity.operationId))?.state, "failed");

    const cancelledWhileQueued = request("repo_test");
    assert.deepEqual(await store.enqueue(cancelledWhileQueued), { ok: true, reused: false });
    assert.equal(await store.cancel(cancelledWhileQueued.identity.operationId), true);
    assert.equal((await store.get(cancelledWhileQueued.identity.operationId))?.state, "cancelled");
    assert.equal(await store.claim("repo_test", 5_000), undefined);

    await database.end();
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const recovered = new PostgresHostRunnerJobStore(database);
    assert.equal((await recovered.get(expiring.identity.operationId))?.state, "completed");
    assert.equal((await recovered.get(cancelled.identity.operationId))?.state, "cancelled");

    const activeJobs = Array.from({ length: 102 }, () => request("repo_many"));
    await Promise.all(activeJobs.map((entry) => recovered.enqueue(entry)));
    const terminalJobs = Array.from({ length: 22 }, () => request("repo_many"));
    await Promise.all(terminalJobs.map(async (entry) => {
      await recovered.enqueue(entry);
      assert.equal(await recovered.cancel(entry.identity.operationId), true);
    }));
    const summaries = await recovered.listSummaries("repo_many");
    assert.equal(summaries.activeTruncated, true);
    assert.equal(summaries.jobs.length, 120);
    assert.equal(summaries.jobs.filter((entry) => entry.state === "queued").length, 100);
    assert.equal(summaries.jobs.filter((entry) => entry.state === "cancelled").length, 20);
    assert.ok(summaries.jobs.every((entry) => entry.repositoryId === "repo_many"));
    assert.ok(summaries.jobs.every((entry) =>
      !("request" in entry) && !("result" in entry) && !("errorMessage" in entry)));
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
