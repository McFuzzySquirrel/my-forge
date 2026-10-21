import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { sha256Digest, type Sha256Digest, type TaskCheckpointV1 } from "../../contract/v1/index.ts";
import {
  GitRefMutationAmbiguousError,
  GitBranchRefUpdater,
  PostgresOperationReceiptStore,
  RepositoryIntegrationAmbiguousError,
  PostgresRepositoryIntegrationAuthority,
  reconcileIntegrationReceipt,
  type CheckpointResolver,
  type GitIntegrationRepository,
  type RepositoryIntegrationRequest,
  type TaskCheckpointResult,
} from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface RepositoryFixture {
  readonly root: string;
  readonly base: string;
  /** Child of base. */
  readonly first: string;
  /** Child of first. */
  readonly second: string;
  /** A different child of base. */
  readonly sibling: string;
}

function repositoryFixture(): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "myforge-repository-integration-"));
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "MyForge tests"]);
  git(root, ["config", "user.email", "myforge-tests@example.invalid"]);
  writeFileSync(join(root, "change.txt"), "base\n");
  git(root, ["add", "change.txt"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);

  writeFileSync(join(root, "change.txt"), "first\n");
  git(root, ["commit", "--quiet", "-am", "first"]);
  const first = git(root, ["rev-parse", "HEAD"]);

  writeFileSync(join(root, "change.txt"), "second\n");
  git(root, ["commit", "--quiet", "-am", "second"]);
  const second = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "--quiet", "--detach", base]);
  writeFileSync(join(root, "change.txt"), "sibling\n");
  git(root, ["commit", "--quiet", "-am", "sibling"]);
  const sibling = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/heads/main", base]);
  return { root, base, first, second, sibling };
}

/** Serves checkpoint records for commits; individual checkpoints can be made unavailable. */
class FixtureCheckpoints implements CheckpointResolver {
  private readonly checkpoints = new Map<Sha256Digest, TaskCheckpointV1>();
  readonly unavailable = new Set<Sha256Digest>();

  constructor(private readonly root: string) {}

  for(runId: string, commit: string): Sha256Digest {
    const digest = sha256Digest(`checkpoint:${runId}:${commit}`);
    this.checkpoints.set(digest, {
      runId,
      gitTreeId: git(this.root, ["rev-parse", `${commit}^{tree}`]),
    } as TaskCheckpointV1);
    return digest;
  }

  async resolveCheckpoint(digest: Sha256Digest): Promise<TaskCheckpointResult> {
    const checkpoint = this.checkpoints.get(digest);
    if (!checkpoint || this.unavailable.has(digest)) return { ok: false, code: "checkpoint-missing", failures: [] };
    return { ok: true, digest, checkpoint };
  }
}

interface Harness {
  readonly authority: PostgresRepositoryIntegrationAuthority;
  readonly receipts: PostgresOperationReceiptStore;
  readonly checkpoints: FixtureCheckpoints;
  readonly fixture: RepositoryFixture;
  readonly database: Pool;
}

async function withAuthority(
  run: (harness: Harness) => Promise<void>,
  gitRepository?: GitIntegrationRepository,
): Promise<void> {
  const schema = `p3_fences_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  let schemaCreated = false;
  const fixture = repositoryFixture();

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const migration of ["repository-integration.sql", "operation-receipts.sql"]) {
      await database.query(await readFile(new URL(`../../storage/postgres/${migration}`, import.meta.url), "utf8"));
    }

    const checkpoints = new FixtureCheckpoints(fixture.root);
    const authority = new PostgresRepositoryIntegrationAuthority(
      database,
      (repositoryId) => repositoryId === "repo_fixture" ? fixture.root : undefined,
      checkpoints,
      gitRepository,
    );
    await run({ authority, receipts: new PostgresOperationReceiptStore(database), checkpoints, fixture, database });
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function leasedRequest(
  { authority, checkpoints, fixture }: Harness,
  overrides: Partial<RepositoryIntegrationRequest> = {},
): Promise<RepositoryIntegrationRequest> {
  const lease = await authority.acquire("repo_fixture", "refs/heads/main", "run_a", 10_000);
  assert.ok(lease.ok);
  return {
    repositoryId: "repo_fixture",
    targetRef: "refs/heads/main",
    fencingToken: lease.lease.fencingToken,
    runId: "run_a",
    taskId: "task_a",
    logicalAttempt: 1,
    operationId: "operation_a",
    expectedHead: fixture.base,
    commitSha: fixture.first,
    checkpointDigest: checkpoints.for("run_a", fixture.first),
    ...overrides,
  };
}

async function integrationRows(database: Pool): Promise<Array<{ commit_sha: string; recorded_by: string }>> {
  const result = await database.query<{ commit_sha: string; recorded_by: string }>(
    "SELECT commit_sha, recorded_by FROM forge_repository_integrations ORDER BY integrated_at",
  );
  return result.rows;
}

class ScriptedGit extends GitBranchRefUpdater {
  constructor(private readonly script: (actual: () => Promise<boolean>) => Promise<boolean>) {
    super();
  }

  override async update(root: string, ref: string, next: string, expected: string): Promise<boolean> {
    return this.script(() => super.update(root, ref, next, expected));
  }
}

const ambiguousAfterUpdate = () => new ScriptedGit(async (actual) => {
  await actual();
  throw new GitRefMutationAmbiguousError("refs/heads/main", new Error("simulated lost Git result"));
});

test("PostgreSQL fencing rejects held, expired, stale, and conflicting integration and honors expected heads", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, checkpoints, fixture } = harness;
    const root = fixture.root;
    const scope = { repositoryId: "repo_fixture", targetRef: "refs/heads/main" };
    const request = await leasedRequest(harness);
    assert.deepEqual(await authority.acquire(scope.repositoryId, scope.targetRef, "run_b", 10_000), {
      ok: false,
      code: "lease-held",
    });

    const integrated = await authority.integrate(request);
    assert.ok(integrated.ok);
    assert.deepEqual({ ...integrated, effectDigest: undefined }, {
      ok: true, commitSha: fixture.first, reused: false, recordedBy: "authority", effectDigest: undefined,
    });
    assert.equal(git(root, ["rev-parse", scope.targetRef]), fixture.first);
    assert.deepEqual(await authority.integrate(request), { ...integrated, reused: true });
    assert.deepEqual(await authority.integrate({
      ...request,
      expectedHead: fixture.first,
      commitSha: fixture.second,
      checkpointDigest: checkpoints.for("run_a", fixture.second),
    }), { ok: false, code: "conflicting-integration" });

    const sibling = {
      ...request,
      taskId: "task_b",
      commitSha: fixture.sibling,
      checkpointDigest: checkpoints.for("run_a", fixture.sibling),
    };
    assert.deepEqual(await authority.integrate(sibling), { ok: false, code: "expected-head-mismatch" });
    assert.deepEqual(await authority.integrate(sibling), { ok: false, code: "integration-abandoned" });
    assert.equal(git(root, ["rev-parse", scope.targetRef]), fixture.first);

    const secondCheckpoint = checkpoints.for("run_a", fixture.second);
    const shortLease = await authority.acquire("repo_fixture", "refs/heads/main", "run_a", 1);
    assert.ok(shortLease.ok);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await authority.integrate({
      ...request,
      fencingToken: shortLease.lease.fencingToken,
      taskId: "task_expired",
      expectedHead: fixture.first,
      commitSha: fixture.second,
      checkpointDigest: secondCheckpoint,
    }), {
      ok: false,
      code: "expired-fencing-token",
    });

    const newerLease = await authority.acquire("repo_fixture", "refs/heads/main", "run_b", 10_000);
    assert.ok(newerLease.ok);
    assert.ok(newerLease.lease.fencingToken > shortLease.lease.fencingToken);
    assert.deepEqual(await authority.integrate({
      ...request,
      fencingToken: shortLease.lease.fencingToken,
      runId: "run_a",
      taskId: "task_stale",
      expectedHead: fixture.first,
      commitSha: fixture.second,
      checkpointDigest: secondCheckpoint,
    }), {
      ok: false,
      code: "stale-fencing-token",
    });
  });
});

test("terminal runs release their leases without reviving released fencing tokens", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, fixture } = harness;
    const request = await leasedRequest(harness);
    assert.deepEqual(await authority.acquire("repo_fixture", "refs/heads/main", "run_b", 10_000), { ok: false, code: "lease-held" });
    assert.equal(await authority.releaseRun("run_b"), 0);
    assert.equal(await authority.releaseRun("run_a"), 1);
    assert.equal(await authority.releaseRun("run_a"), 0);
    assert.deepEqual(await authority.integrate(request), { ok: false, code: "no-lease" });

    const next = await authority.acquire("repo_fixture", "refs/heads/main", "run_b", 10_000);
    assert.ok(next.ok);
    assert.ok(next.lease.fencingToken > request.fencingToken);
    assert.deepEqual(await authority.integrate(request), { ok: false, code: "stale-fencing-token" });
    assert.equal(git(fixture.root, ["rev-parse", "refs/heads/main"]), fixture.base);
  });
});

test("integration requires a verified checkpoint bound to the commit", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, checkpoints, fixture, database } = harness;
    const request = await leasedRequest(harness);

    checkpoints.unavailable.add(request.checkpointDigest);
    assert.deepEqual(await authority.integrate(request), { ok: false, code: "checkpoint-unavailable" });
    checkpoints.unavailable.delete(request.checkpointDigest);

    assert.deepEqual(await authority.integrate({ ...request, checkpointDigest: checkpoints.for("run_a", fixture.second) }), {
      ok: false,
      code: "commit-checkpoint-mismatch",
    }, "the commit's tree must be the checkpoint tree");
    assert.deepEqual(await authority.integrate({
      ...request,
      commitSha: fixture.second,
      checkpointDigest: checkpoints.for("run_a", fixture.second),
    }), { ok: false, code: "commit-checkpoint-mismatch" }, "the commit must sit directly on the expected head");
    assert.deepEqual(await authority.integrate({ ...request, checkpointDigest: checkpoints.for("run_other", fixture.first) }), {
      ok: false,
      code: "commit-checkpoint-mismatch",
    }, "the checkpoint must belong to the integrating run");

    assert.equal(git(fixture.root, ["rev-parse", "refs/heads/main"]), fixture.base);
    const intents = await database.query("SELECT 1 FROM forge_repository_integration_intents");
    assert.equal(intents.rowCount, 0, "rejected bindings record no intent");
  });
});

test("a new lease cannot be granted while the fenced Git mutation is in progress", {
  skip: !connectionString,
}, async () => {
  let started!: () => void;
  let unblock!: () => void;
  const updateStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const delayingGit = new ScriptedGit(async (actual) => {
    started();
    await blocked;
    return actual();
  });

  try {
    await withAuthority(async (harness) => {
      const { authority, fixture } = harness;
      const request = await leasedRequest(harness);
      const integration = authority.integrate(request);
      await updateStarted;

      let acquisitionSettled = false;
      const acquisition = authority.acquire("repo_fixture", request.targetRef, "run_b", 10_000)
        .then((result) => {
          acquisitionSettled = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(acquisitionSettled, false);

      unblock();
      const result = await integration;
      assert.ok(result.ok && !result.reused && result.commitSha === fixture.first);
      assert.deepEqual(await acquisition, { ok: false, code: "lease-held" });
    }, delayingGit);
  } finally {
    unblock();
  }
});

test("an indeterminate Git result is ambiguous, and redelivery records the existing commit instead of reapplying it", {
  skip: !connectionString,
}, async () => {
  let crash = true;
  const gitRepository = new ScriptedGit(async (actual) => {
    const updated = await actual();
    if (crash) throw new GitRefMutationAmbiguousError("refs/heads/main", new Error("simulated lost Git result"));
    return updated;
  });

  await withAuthority(async (harness) => {
    const { authority, fixture, database } = harness;
    const request = await leasedRequest(harness);
    await assert.rejects(
      authority.integrate(request),
      (error: unknown) => error instanceof RepositoryIntegrationAmbiguousError,
    );
    assert.equal(git(fixture.root, ["rev-parse", request.targetRef]), fixture.first);
    assert.deepEqual(await integrationRows(database), []);

    crash = false;
    const redelivered = await authority.integrate(request);
    assert.ok(redelivered.ok);
    assert.equal(redelivered.reused, true);
    assert.equal(redelivered.recordedBy, "reconciliation");
    assert.equal(git(fixture.root, ["rev-parse", request.targetRef]), fixture.first);
    assert.equal(git(fixture.root, ["rev-list", "--count", request.targetRef]), "2", "no duplicate commit");
    assert.deepEqual(await integrationRows(database), [{ commit_sha: fixture.first, recorded_by: "reconciliation" }]);
  }, gitRepository);
});

test("reconciliation accepts an integrated commit whose record and receipt were lost", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, receipts, database, fixture } = harness;
    const request = await leasedRequest(harness);
    const key = { runId: request.runId, taskId: request.taskId, logicalAttempt: request.logicalAttempt, operationId: request.operationId };
    assert.ok((await receipts.claim(key)).ok);
    assert.ok((await receipts.transition(key, 1, "executing")).ok);

    await assert.rejects(authority.integrate(request), RepositoryIntegrationAmbiguousError);
    assert.ok((await receipts.transition(key, 2, "ambiguous", { diagnosticRef: "diag://lost-result" })).ok);

    const reconciled = await reconcileIntegrationReceipt(receipts, authority, request);
    assert.equal(reconciled.resolution, "accepted");
    assert.ok(reconciled.integration?.outcome === "integrated");
    assert.equal(reconciled.integration.backfilled, true);
    assert.equal(reconciled.receipt.effectDigest, reconciled.integration.effectDigest);
    assert.deepEqual(reconciled.receipt.diagnosticRefs, [
      "diag://lost-result",
      `git-integration:reconciliation:${fixture.first}`,
    ]);
    assert.deepEqual(await integrationRows(database), [{ commit_sha: fixture.first, recorded_by: "reconciliation" }]);

    const repeat = await reconcileIntegrationReceipt(receipts, authority, request);
    assert.equal(repeat.receipt.recordVersion, reconciled.receipt.recordVersion);
    const redelivered = await authority.integrate(request);
    assert.ok(redelivered.ok && redelivered.reused);
    assert.equal(redelivered.effectDigest, reconciled.receipt.effectDigest);
    assert.equal(git(fixture.root, ["rev-list", "--count", request.targetRef]), "2");
  }, ambiguousAfterUpdate());
});

test("reconciliation fails and fences an attempt whose commit never reached the branch", {
  skip: !connectionString,
}, async () => {
  let crash = true;
  const gitRepository = new ScriptedGit(async (actual) => {
    if (crash) throw new Error("simulated worker crash before the ref update");
    return actual();
  });

  await withAuthority(async (harness) => {
    const { authority, receipts, fixture } = harness;
    const request = await leasedRequest(harness);
    const key = { runId: request.runId, taskId: request.taskId, logicalAttempt: request.logicalAttempt, operationId: request.operationId };
    await receipts.claim(key);
    await receipts.transition(key, 1, "executing");
    await assert.rejects(authority.integrate(request), /simulated worker crash/);

    const reconciled = await reconcileIntegrationReceipt(receipts, authority, request);
    assert.equal(reconciled.resolution, "failed");
    assert.deepEqual(reconciled.integration, { outcome: "not-integrated", reason: "commit-not-on-target" });
    assert.deepEqual(reconciled.receipt.diagnosticRefs, ["git-integration:not-integrated:commit-not-on-target"]);

    crash = false;
    assert.deepEqual(await authority.integrate(request), { ok: false, code: "integration-abandoned" });
    assert.equal(git(fixture.root, ["rev-parse", request.targetRef]), fixture.base);

    const unstarted = { ...request, taskId: "task_unstarted", operationId: "operation_unstarted" };
    const unstartedKey = { ...key, taskId: unstarted.taskId, operationId: unstarted.operationId };
    await receipts.claim(unstartedKey);
    const tombstoned = await reconcileIntegrationReceipt(receipts, authority, unstarted);
    assert.equal(tombstoned.receipt.state, "failed");
    assert.deepEqual(tombstoned.integration, { outcome: "not-integrated", reason: "no-intent" });
    assert.deepEqual(await authority.integrate(unstarted), { ok: false, code: "integration-abandoned" });
  }, gitRepository);
});

test("reconciliation blocks an integrated commit whose checkpoint is unavailable", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, receipts, checkpoints, database, fixture } = harness;
    const request = await leasedRequest(harness);
    const key = { runId: request.runId, taskId: request.taskId, logicalAttempt: request.logicalAttempt, operationId: request.operationId };
    await receipts.claim(key);
    await receipts.transition(key, 1, "executing");
    await assert.rejects(authority.integrate(request), RepositoryIntegrationAmbiguousError);

    checkpoints.unavailable.add(request.checkpointDigest);
    const blocked = await reconcileIntegrationReceipt(receipts, authority, request);
    assert.equal(blocked.resolution, "blocked");
    assert.equal(blocked.blockedReason, "checkpoint-unavailable");
    assert.equal(blocked.receipt.state, "ambiguous");
    assert.deepEqual(blocked.receipt.diagnosticRefs, ["git-integration:blocked:checkpoint-unavailable"]);
    assert.deepEqual(await integrationRows(database), [],
      "an unverifiable effect is not recorded; its pending intent keeps the audit trail");

    checkpoints.unavailable.delete(request.checkpointDigest);
    const accepted = await reconcileIntegrationReceipt(receipts, authority, request);
    assert.equal(accepted.resolution, "accepted");
    assert.deepEqual(await integrationRows(database), [{ commit_sha: fixture.first, recorded_by: "reconciliation" }]);
  }, ambiguousAfterUpdate());
});

test("an unresolved integration blocks the branch until reconciliation resolves it", {
  skip: !connectionString,
}, async () => {
  let crash: "after-update" | "before-update" | undefined = "after-update";
  const gitRepository = new ScriptedGit(async (actual) => {
    if (crash === "before-update") throw new Error("simulated worker crash before the ref update");
    const updated = await actual();
    if (crash === "after-update") throw new GitRefMutationAmbiguousError("refs/heads/main", new Error("simulated lost Git result"));
    return updated;
  });

  await withAuthority(async (harness) => {
    const { authority, receipts, checkpoints, database, fixture } = harness;
    // A's commit lands but its outcome is lost.
    const a = await leasedRequest(harness);
    await assert.rejects(authority.integrate(a), RepositoryIntegrationAmbiguousError);
    crash = undefined;
    const blockingAttempt = {
      repositoryId: a.repositoryId, targetRef: a.targetRef, runId: a.runId, taskId: a.taskId,
      logicalAttempt: a.logicalAttempt, operationId: a.operationId,
    };

    // A dependent task built on A's commit cannot continue while A is unresolved.
    const b = { ...a, taskId: "task_b", operationId: "operation_b", expectedHead: fixture.first, commitSha: fixture.second,
      checkpointDigest: checkpoints.for("run_a", fixture.second) };
    assert.deepEqual(await authority.integrate(b), { ok: false, code: "unresolved-integration", blockingAttempt });

    // Reconciliation that cannot verify A's checkpoint keeps the branch blocked.
    checkpoints.unavailable.add(a.checkpointDigest);
    assert.deepEqual(await authority.reconcile(a), { outcome: "blocked", reason: "checkpoint-unavailable" });
    assert.deepEqual(await authority.integrate(b), { ok: false, code: "unresolved-integration", blockingAttempt });
    assert.equal(git(fixture.root, ["rev-parse", a.targetRef]), fixture.first, "the branch did not advance past A");

    // Once A is proven integrated, continuation proceeds.
    checkpoints.unavailable.delete(a.checkpointDigest);
    const aKey = { runId: a.runId, taskId: a.taskId, logicalAttempt: a.logicalAttempt, operationId: a.operationId };
    await receipts.claim(aKey);
    await receipts.transition(aKey, 1, "executing");
    assert.equal((await reconcileIntegrationReceipt(receipts, authority, a)).resolution, "accepted");
    const continued = await authority.integrate(b);
    assert.ok(continued.ok && !continued.reused);
    assert.equal(git(fixture.root, ["rev-parse", a.targetRef]), fixture.second);

    // An interrupted attempt that never reached the branch also blocks, and is abandoned by reconciliation.
    git(fixture.root, ["checkout", "--quiet", "--detach", fixture.second]);
    writeFileSync(join(fixture.root, "change.txt"), "third\n");
    git(fixture.root, ["commit", "--quiet", "-am", "third"]);
    const third = git(fixture.root, ["rev-parse", "HEAD"]);
    crash = "before-update";
    const c = { ...a, taskId: "task_c", operationId: "operation_c", expectedHead: fixture.second, commitSha: third,
      checkpointDigest: checkpoints.for("run_a", third) };
    await assert.rejects(authority.integrate(c), /simulated worker crash/);
    crash = undefined;
    const d = { ...c, taskId: "task_d", operationId: "operation_d" };
    const dResult = await authority.integrate(d);
    assert.equal(dResult.ok, false);
    assert.equal(!dResult.ok && dResult.code, "unresolved-integration");
    assert.deepEqual(await authority.reconcile(c), { outcome: "not-integrated", reason: "commit-not-on-target" });
    assert.deepEqual(await authority.integrate(c), { ok: false, code: "integration-abandoned" });
    assert.deepEqual(await integrationRows(database), [
      { commit_sha: fixture.first, recorded_by: "reconciliation" },
      { commit_sha: fixture.second, recorded_by: "authority" },
    ]);
  }, gitRepository);
});

test("integration refuses to build on a branch that lost the run's earlier integrations", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (harness) => {
    const { authority, checkpoints, database, fixture } = harness;
    const a = await leasedRequest(harness);
    const integrated = await authority.integrate(a);
    assert.ok(integrated.ok);

    // The stores remember A, but the branch is moved back (for example, a runtime restore Git did not follow).
    git(fixture.root, ["update-ref", "refs/heads/main", fixture.base]);
    const b = { ...a, taskId: "task_b", operationId: "operation_b", expectedHead: fixture.base, commitSha: fixture.sibling,
      checkpointDigest: checkpoints.for("run_a", fixture.sibling) };
    assert.deepEqual(await authority.integrate(b), { ok: false, code: "integration-history-missing" });
    assert.equal(git(fixture.root, ["rev-parse", "refs/heads/main"]), fixture.base, "the branch did not advance");
    assert.deepEqual(await authority.reconcile(b), { outcome: "not-integrated", reason: "integration-history-missing" });
    assert.deepEqual(await authority.integrate(b), { ok: false, code: "integration-abandoned" });
    assert.deepEqual(await integrationRows(database), [{ commit_sha: fixture.first, recorded_by: "authority" }]);
  });
});
