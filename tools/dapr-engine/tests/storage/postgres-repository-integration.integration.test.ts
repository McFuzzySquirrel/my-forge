import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  GitRefMutationAmbiguousError,
  GitBranchRefUpdater,
  RepositoryIntegrationAmbiguousError,
  PostgresRepositoryIntegrationAuthority,
  type GitRefUpdater,
  type RepositoryIntegrationRequest,
} from "../../storage/index.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryFixture(): { readonly root: string; readonly base: string; readonly first: string; readonly second: string } {
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
  git(root, ["update-ref", "refs/heads/main", base]);
  return { root, base, first, second };
}

async function withAuthority(
  run: (
    authority: PostgresRepositoryIntegrationAuthority,
    fixture: ReturnType<typeof repositoryFixture>,
  ) => Promise<void>,
  refUpdater?: GitRefUpdater,
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
    const migration = await readFile(
      new URL("../../storage/postgres/repository-integration.sql", import.meta.url),
      "utf8",
    );
    await database.query(migration);

    const authority = new PostgresRepositoryIntegrationAuthority(
      database,
      (repositoryId) => repositoryId === "repo_fixture" ? fixture.root : undefined,
      refUpdater,
    );
    await run(authority, fixture);
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("PostgreSQL fencing rejects held, expired, stale, and conflicting integration and honors expected heads", {
  skip: !connectionString,
}, async () => {
  await withAuthority(async (authority, fixture) => {
    const root = fixture.root;
    const scope = { repositoryId: "repo_fixture", targetRef: "refs/heads/main" };
    const firstLease = await authority.acquire(scope.repositoryId, scope.targetRef, "run_a", 10_000);
    assert.ok(firstLease.ok);
    assert.deepEqual(await authority.acquire(scope.repositoryId, scope.targetRef, "run_b", 10_000), {
      ok: false,
      code: "lease-held",
    });

    const request: RepositoryIntegrationRequest = {
      ...scope,
      fencingToken: firstLease.lease.fencingToken,
      runId: "run_a",
      taskId: "task_a",
      logicalAttempt: 1,
      operationId: "operation_a",
      expectedHead: fixture.base,
      commitSha: fixture.first,
    };
    assert.deepEqual(await authority.integrate(request), {
      ok: true,
      commitSha: fixture.first,
      reused: false,
    });
    assert.equal(git(root, ["rev-parse", scope.targetRef]), fixture.first);
    assert.deepEqual(await authority.integrate(request), {
      ok: true,
      commitSha: fixture.first,
      reused: true,
    });
    assert.deepEqual(await authority.integrate({ ...request, commitSha: fixture.second }), {
      ok: false,
      code: "conflicting-integration",
    });
    assert.deepEqual(await authority.integrate({
      ...request,
      taskId: "task_b",
      logicalAttempt: 1,
      expectedHead: fixture.base,
      commitSha: fixture.second,
    }), {
      ok: false,
      code: "expected-head-mismatch",
    });

    const shortLease = await authority.acquire("repo_fixture", "refs/heads/main", "run_a", 1);
    assert.ok(shortLease.ok);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await authority.integrate({
      ...request,
      fencingToken: shortLease.lease.fencingToken,
      taskId: "task_expired",
      expectedHead: fixture.first,
      commitSha: fixture.second,
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
    }), {
      ok: false,
      code: "stale-fencing-token",
    });
  });
});

test("a new lease cannot be granted while the fenced Git mutation is in progress", {
  skip: !connectionString,
}, async () => {
  let started!: () => void;
  let unblock!: () => void;
  const updateStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const actualUpdater = new GitBranchRefUpdater();
  const delayingUpdater: GitRefUpdater = {
    async update(repositoryRoot, targetRef, newObject, expectedOldObject) {
      started();
      await blocked;
      return actualUpdater.update(repositoryRoot, targetRef, newObject, expectedOldObject);
    },
  };

  try {
    await withAuthority(async (authority, fixture) => {
      const lease = await authority.acquire("repo_fixture", "refs/heads/main", "run_a", 10_000);
      assert.ok(lease.ok);
      const request: RepositoryIntegrationRequest = {
        repositoryId: "repo_fixture",
        targetRef: "refs/heads/main",
        fencingToken: lease.lease.fencingToken,
        runId: "run_a",
        taskId: "task_a",
        logicalAttempt: 1,
        operationId: "operation_a",
        expectedHead: fixture.base,
        commitSha: fixture.first,
      };
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
      assert.deepEqual(await integration, { ok: true, commitSha: fixture.first, reused: false });
      assert.deepEqual(await acquisition, { ok: false, code: "lease-held" });
    }, delayingUpdater);
  } finally {
    unblock();
  }
});

test("an indeterminate Git result is surfaced as an ambiguous integration", {
  skip: !connectionString,
}, async () => {
  const actualUpdater = new GitBranchRefUpdater();
  const ambiguousUpdater: GitRefUpdater = {
    async update(repositoryRoot, targetRef, newObject, expectedOldObject) {
      await actualUpdater.update(repositoryRoot, targetRef, newObject, expectedOldObject);
      throw new GitRefMutationAmbiguousError(targetRef, new Error("simulated lost Git result"));
    },
  };

  await withAuthority(async (authority, fixture) => {
    const lease = await authority.acquire("repo_fixture", "refs/heads/main", "run_a", 10_000);
    assert.ok(lease.ok);
    const request: RepositoryIntegrationRequest = {
      repositoryId: "repo_fixture",
      targetRef: "refs/heads/main",
      fencingToken: lease.lease.fencingToken,
      runId: "run_a",
      taskId: "task_a",
      logicalAttempt: 1,
      operationId: "operation_a",
      expectedHead: fixture.base,
      commitSha: fixture.first,
    };

    await assert.rejects(
      authority.integrate(request),
      (error: unknown) => error instanceof RepositoryIntegrationAmbiguousError,
    );
    assert.equal(git(fixture.root, ["rev-parse", request.targetRef]), fixture.first);
  }, ambiguousUpdater);
});
