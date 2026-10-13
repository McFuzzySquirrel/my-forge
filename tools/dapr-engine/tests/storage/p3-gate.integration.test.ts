import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { sha256Digest, type OperationKeyV1, type Sha256Digest, type TaskCheckpointV1 } from "../../contract/v1/index.ts";
import {
  captureWorkspaceCheckpoint,
  CheckpointWorkspaceReconstructor,
  superviseExecution,
} from "../../execution/index.ts";
import {
  FileArtifactCheckpointStore,
  GitBranchRefUpdater,
  GitRefMutationAmbiguousError,
  PostgresExecutionOwnershipStore,
  PostgresOperationReceiptStore,
  PostgresRepositoryIntegrationAuthority,
  reconcileIntegrationReceipt,
  RepositoryIntegrationAmbiguousError,
  type RepositoryIntegrationRequest,
} from "../../storage/index.ts";

// P3-GATE composed evidence: real PostgreSQL stores, a real Git target
// repository, the file artifact/checkpoint store, checkpoint capture and
// reconstruction, and the execution supervisor, exercised together.

const connectionString = process.env.POSTGRES_TEST_URL;
const RUN_ID = "run_gate";
const REPOSITORY_ID = "repo_gate";
const TARGET_REF = "refs/heads/main";
const MANIFEST = sha256Digest("p3-gate-manifest");
const COMMIT_DATE = "2026-01-01T00:00:00Z";
const TTL_MS = 300;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

/** Fails the next ref update in a chosen way, then behaves normally. */
class CrashingGit extends GitBranchRefUpdater {
  crash: "after-update" | undefined;

  override async update(root: string, ref: string, next: string, expected: string): Promise<boolean> {
    const crash = this.crash;
    this.crash = undefined;
    const updated = await super.update(root, ref, next, expected);
    if (crash === "after-update") throw new GitRefMutationAmbiguousError(ref, new Error("simulated lost Git result"));
    return updated;
  }
}

interface Gate {
  readonly root: string;
  readonly target: string;
  readonly base: string;
  readonly store: FileArtifactCheckpointStore;
  readonly reconstructor: CheckpointWorkspaceReconstructor;
  readonly receipts: PostgresOperationReceiptStore;
  readonly executions: PostgresExecutionOwnershipStore;
  readonly authority: PostgresRepositoryIntegrationAuthority;
  readonly gitRepository: CrashingGit;
  readonly database: Pool;
}

async function withGate(run: (gate: Gate) => Promise<void>): Promise<void> {
  const schema = `p3_gate_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const root = await mkdtemp(join(tmpdir(), "myforge-p3-gate-"));
  let database: Pool | undefined;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const file of ["repository-integration.sql", "operation-receipts.sql", "operation-executions.sql"]) {
      await database.query(await readFile(new URL(`../../storage/postgres/${file}`, import.meta.url), "utf8"));
    }

    const target = join(root, "target");
    git(root, ["init", "--quiet", "--initial-branch=main", target]);
    git(target, ["config", "user.name", "MyForge gate"]);
    git(target, ["config", "user.email", "myforge-gate@example.invalid"]);
    await writeFile(join(target, "change.txt"), "base\n");
    await writeFile(join(target, "legacy.txt"), "remove me\n");
    git(target, ["add", "-A"]);
    git(target, ["commit", "--quiet", "-m", "base"]);
    const base = git(target, ["rev-parse", "HEAD"]);
    git(target, ["checkout", "--quiet", "--detach"]);

    const store = new FileArtifactCheckpointStore(join(root, "artifact-store"));
    const gitRepository = new CrashingGit();
    await run({
      root,
      target,
      base,
      store,
      reconstructor: new CheckpointWorkspaceReconstructor({ workspaceRoot: join(root, "workspaces"), store }),
      receipts: new PostgresOperationReceiptStore(database),
      executions: new PostgresExecutionOwnershipStore(database),
      authority: new PostgresRepositoryIntegrationAuthority(
        database,
        (repositoryId) => repositoryId === REPOSITORY_ID ? target : undefined,
        store,
        gitRepository,
      ),
      gitRepository,
      database,
    });
  } finally {
    if (database) await database.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function executing(gate: Gate, taskId: string): Promise<OperationKeyV1> {
  const key: OperationKeyV1 = { runId: RUN_ID, taskId, logicalAttempt: 1, operationId: "integrate" };
  assert.ok((await gate.receipts.claim(key)).ok);
  assert.ok((await gate.receipts.transition(key, 1, "executing")).ok);
  return key;
}

async function lease(gate: Gate): Promise<number> {
  const granted = await gate.authority.acquire(REPOSITORY_ID, TARGET_REF, RUN_ID, 30_000);
  assert.ok(granted.ok);
  return granted.lease.fencingToken;
}

async function capture(gate: Gate, workspacePath: string, baseRevision: string) {
  const evidence = new TextEncoder().encode("validation passed\n");
  const published = await gate.store.publishArtifact(evidence, {
    mediaType: "text/plain",
    sizeBytes: evidence.byteLength,
    sha256: sha256Digest(evidence),
    retentionClass: "checkpoint-evidence",
  });
  assert.ok(published.ok);
  const captured = await captureWorkspaceCheckpoint({
    validationEvidence: [published.ref],
    workspacePath,
    baseRevision,
    runId: RUN_ID,
    manifestDigest: MANIFEST,
    publisher: gate.store,
    toolchain: [{ name: "Node.js", version: process.version }],
    commitDate: COMMIT_DATE,
  });
  assert.ok(captured.ok, JSON.stringify(captured));
  return captured;
}

/** The integrator imports only the checkpoint bundle's objects; no workspace has write access to the target. */
async function importCheckpoint(gate: Gate, checkpoint: TaskCheckpointV1): Promise<void> {
  const bundle = await gate.store.resolveArtifact(checkpoint.gitObjectBundle);
  assert.ok(bundle.ok);
  const path = join(gate.root, `${randomUUID()}.bundle`);
  await writeFile(path, bundle.bytes);
  git(gate.target, ["fetch", "--quiet", "--no-tags", path, "refs/heads/checkpoint"]);
  await rm(path);
}

function request(
  key: OperationKeyV1,
  fencingToken: number,
  expectedHead: string,
  captured: { readonly digest: Sha256Digest; readonly resultCommit: string },
): RepositoryIntegrationRequest {
  return {
    ...key,
    repositoryId: REPOSITORY_ID,
    targetRef: TARGET_REF,
    fencingToken,
    expectedHead,
    commitSha: captured.resultCommit,
    checkpointDigest: captured.digest,
  };
}

async function integrationCount(database: Pool): Promise<number> {
  const result = await database.query<{ count: string }>("SELECT count(*) FROM forge_repository_integrations");
  return Number(result.rows[0]?.count);
}

test("P3-GATE: a redelivered activity rebuilds from its checkpoint, yields one accepted effect, and fences the stale owner", {
  skip: !connectionString,
}, async () => {
  await withGate(async (gate) => {
    const key = await executing(gate, "task_a");

    // Worker A owns epoch 1, edits a clone, captures, and integrates; the
    // ref update lands but its result is lost, and then A stops heartbeating.
    const startedA = await gate.executions.start({ key, workerId: "worker-a", budgetMs: 60_000, heartbeatTtlMs: TTL_MS });
    assert.ok(startedA.ok);
    const claimA = { executionEpoch: startedA.execution.executionEpoch, workerId: "worker-a" };
    const tokenA = await lease(gate);
    const workspaceA = join(gate.root, "worker-a");
    git(gate.root, ["clone", "--quiet", gate.target, workspaceA]);
    git(workspaceA, ["checkout", "--quiet", "--detach", gate.base]);
    await writeFile(join(workspaceA, "change.txt"), "task a\n");
    await writeFile(join(workspaceA, "feature.bin"), Uint8Array.from([0, 7, 255]));
    await rm(join(workspaceA, "legacy.txt"));
    const capturedA = await capture(gate, workspaceA, gate.base);
    await writeFile(join(workspaceA, "uncommitted-after-checkpoint.txt"), "must not be resumed\n");
    await importCheckpoint(gate, capturedA.checkpoint);
    gate.gitRepository.crash = "after-update";
    await assert.rejects(gate.authority.integrate(request(key, tokenA, gate.base, capturedA)), RepositoryIntegrationAmbiguousError);
    assert.equal(git(gate.target, ["rev-parse", TARGET_REF]), capturedA.resultCommit);

    await delay(TTL_MS + 100);
    assert.deepEqual(await gate.executions.heartbeat(key, claimA, TTL_MS), { ok: false, code: "execution-expired" });
    assert.deepEqual((await gate.executions.fenceLostExecutions()).map((lost) => lost.execution.key.taskId), ["task_a"]);

    // Worker B takes over epoch 2 under supervision, rebuilds the workspace
    // from the checkpoint alone, and redelivers the same logical attempt.
    const tokenB = await lease(gate);
    const supervised = await superviseExecution({
      store: gate.executions,
      key,
      workerId: "worker-b",
      budgetMs: 60_000,
      heartbeatIntervalMs: 50,
      heartbeatTtlMs: TTL_MS,
      exitStatus: () => 0,
      run: async () => {
        const rebuilt = await gate.reconstructor.reconstruct({ checkpointDigest: capturedA.digest });
        assert.ok(rebuilt.ok, JSON.stringify(rebuilt));
        try {
          await assert.rejects(readFile(join(rebuilt.workspace.path, "uncommitted-after-checkpoint.txt")), /ENOENT/);
          assert.equal(await readFile(join(rebuilt.workspace.path, "change.txt"), "utf8"), "task a\n");
          const recaptured = await capture(gate, rebuilt.workspace.path, gate.base);
          assert.equal(recaptured.resultCommit, capturedA.resultCommit, "the same checkpoint yields the same commit");
          return await gate.authority.integrate(request(key, tokenB, gate.base, recaptured));
        } finally {
          await gate.reconstructor.destroy(rebuilt.workspace);
        }
      },
    });
    assert.ok(supervised.started);
    assert.equal(supervised.claim.executionEpoch, 2);
    assert.equal(supervised.cleanup, "observed");
    assert.ok(supervised.result?.ok, JSON.stringify(supervised.result));
    assert.equal(supervised.result.reused, true);
    assert.equal(supervised.result.commitSha, capturedA.resultCommit);

    const executingReceipt = await gate.receipts.get(key);
    assert.ok(executingReceipt);
    const published = await gate.executions.publishOutcome(key, supervised.claim, {
      expectedReceiptVersion: executingReceipt.recordVersion,
      to: "effect-published",
      effectDigest: supervised.result.effectDigest,
    });
    assert.ok(published.ok, JSON.stringify(published));
    const accepted = await reconcileIntegrationReceipt(gate.receipts, gate.authority, { ...key, repositoryId: REPOSITORY_ID, targetRef: TARGET_REF });
    assert.equal(accepted.resolution, "accepted");
    assert.equal(accepted.receipt.effectDigest, supervised.result.effectDigest);

    // Exactly one effect: one commit on the branch and one integration record.
    assert.equal(git(gate.target, ["rev-list", "--count", `${gate.base}..${TARGET_REF}`]), "1");
    assert.equal(await integrationCount(gate.database), 1);

    // The stale owner can no longer renew, publish, or move the branch.
    assert.deepEqual(await gate.executions.heartbeat(key, claimA, TTL_MS), { ok: false, code: "stale-execution" });
    const late = await gate.executions.publishOutcome(key, claimA, {
      expectedReceiptVersion: accepted.receipt.recordVersion,
      to: "effect-published",
      effectDigest: supervised.result.effectDigest,
    });
    assert.equal(late.ok, false);
    assert.equal((await gate.receipts.get(key))?.state, "accepted");
    assert.deepEqual(await gate.authority.integrate(request(key, tokenA, gate.base, capturedA)), {
      ok: false, code: "stale-fencing-token",
    });
    await writeFile(join(workspaceA, "change.txt"), "stale rewrite\n");
    const staleRewrite = await capture(gate, workspaceA, capturedA.resultCommit);
    await importCheckpoint(gate, staleRewrite.checkpoint);
    const staleKey = { ...key, logicalAttempt: 2 };
    assert.deepEqual(await gate.authority.integrate(request(staleKey, tokenA, capturedA.resultCommit, staleRewrite)), {
      ok: false, code: "stale-fencing-token",
    });
    assert.equal(git(gate.target, ["rev-parse", TARGET_REF]), capturedA.resultCommit);

    // A further redelivery cannot relaunch the published execution.
    const relaunch = await superviseExecution({
      store: gate.executions,
      key,
      workerId: "worker-c",
      budgetMs: 60_000,
      heartbeatIntervalMs: 50,
      heartbeatTtlMs: TTL_MS,
      run: async () => assert.fail("a published execution must not run again"),
    });
    assert.equal(relaunch.started, false);
  });
});

test("P3-GATE: an ambiguous integration is visible and blocks a dependent task until it is reconciled", {
  skip: !connectionString,
}, async () => {
  await withGate(async (gate) => {
    const token = await lease(gate);
    const keyA = await executing(gate, "task_a");
    const workspaceA = join(gate.root, "task-a");
    git(gate.root, ["clone", "--quiet", gate.target, workspaceA]);
    git(workspaceA, ["checkout", "--quiet", "--detach", gate.base]);
    await writeFile(join(workspaceA, "change.txt"), "task a\n");
    const capturedA = await capture(gate, workspaceA, gate.base);
    await importCheckpoint(gate, capturedA.checkpoint);
    gate.gitRepository.crash = "after-update";
    await assert.rejects(gate.authority.integrate(request(keyA, token, gate.base, capturedA)), RepositoryIntegrationAmbiguousError);

    // The dependent task builds on A's checkpoint but cannot advance the branch.
    const keyB = await executing(gate, "task_b");
    const rebuilt = await gate.reconstructor.reconstruct({ checkpointDigest: capturedA.digest });
    assert.ok(rebuilt.ok);
    await writeFile(join(rebuilt.workspace.path, "dependent.txt"), "task b\n");
    const capturedB = await capture(gate, rebuilt.workspace.path, capturedA.resultCommit);
    await gate.reconstructor.destroy(rebuilt.workspace);
    await importCheckpoint(gate, capturedB.checkpoint);
    const requestB = request(keyB, token, capturedA.resultCommit, capturedB);
    const blockedB = await gate.authority.integrate(requestB);
    assert.deepEqual(blockedB, {
      ok: false,
      code: "unresolved-integration",
      blockingAttempt: { ...keyA, repositoryId: REPOSITORY_ID, targetRef: TARGET_REF },
    });

    // A's checkpoint is unavailable, so reconciliation cannot accept it: the
    // receipt is visibly ambiguous and the dependent task stays blocked.
    const checkpointHex = capturedA.digest.slice("sha256:".length);
    const checkpointPath = join(gate.root, "artifact-store", "checkpoints", "sha256", checkpointHex.slice(0, 2), `${checkpointHex.slice(2)}.json`);
    await rm(checkpointPath);
    const scopeA = { ...keyA, repositoryId: REPOSITORY_ID, targetRef: TARGET_REF };
    const blocked = await reconcileIntegrationReceipt(gate.receipts, gate.authority, scopeA);
    assert.equal(blocked.resolution, "blocked");
    assert.equal(blocked.receipt.state, "ambiguous");
    assert.deepEqual(blocked.receipt.diagnosticRefs, ["git-integration:blocked:checkpoint-unavailable"]);
    assert.equal((await gate.authority.integrate(requestB)).ok, false);
    assert.equal(await integrationCount(gate.database), 0);
    assert.equal(git(gate.target, ["rev-parse", TARGET_REF]), capturedA.resultCommit);

    // Operator restores the checkpoint; reconciliation accepts A and B proceeds.
    assert.ok((await gate.store.publishCheckpoint(capturedA.checkpoint)).ok);
    const accepted = await reconcileIntegrationReceipt(gate.receipts, gate.authority, scopeA);
    assert.equal(accepted.resolution, "accepted");
    const integratedB = await gate.authority.integrate(requestB);
    assert.ok(integratedB.ok, JSON.stringify(integratedB));
    assert.equal(integratedB.reused, false);
    assert.equal(git(gate.target, ["rev-parse", TARGET_REF]), capturedB.resultCommit);
    assert.equal(git(gate.target, ["rev-list", "--count", `${gate.base}..${TARGET_REF}`]), "2");
    assert.equal(await integrationCount(gate.database), 2);
  });
});
