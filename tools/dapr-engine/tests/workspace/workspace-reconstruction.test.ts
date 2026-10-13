import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  sha256Digest,
  type ArtifactRefV1,
  type Sha256Digest,
  type TaskCheckpointV1,
} from "../../contract/v1/index.ts";
import {
  FileArtifactCheckpointStore,
  type TaskCheckpointResult,
} from "../../storage/index.ts";
import {
  captureWorkspaceCheckpoint,
  CheckpointWorkspaceReconstructor,
  resolveWorkspaceCredentialEnvironment,
  type WorkspaceCheckpointStore,
  type WorkspaceSecretResolveRequest,
} from "../../execution/workspace-reconstruction.ts";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

async function publishArtifact(
  store: FileArtifactCheckpointStore,
  content: Uint8Array,
  mediaType: string,
): Promise<ArtifactRefV1> {
  const result = await store.publishArtifact(content, {
    mediaType,
    sizeBytes: content.byteLength,
    sha256: sha256Digest(content),
    retentionClass: "checkpoint-evidence",
  });
  assert.ok(result.ok);
  return result.ref;
}

interface CheckpointFixture {
  readonly root: string;
  readonly source: string;
  readonly store: FileArtifactCheckpointStore;
  readonly checkpoint: TaskCheckpointV1;
  readonly digest: Sha256Digest;
}

async function createFixture(options: { symlinkTarget?: string } = {}): Promise<CheckpointFixture> {
  const root = await mkdtemp(join(tmpdir(), "myforge-workspace-test-"));
  const source = join(root, "source");
  const store = new FileArtifactCheckpointStore(join(root, "artifact-store"));
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "assets"), { recursive: true });
  git(root, ["init", "--quiet", "--initial-branch=main", source]);
  git(source, ["config", "user.name", "MyForge test"]);
  git(source, ["config", "user.email", "myforge-test@example.invalid"]);
  await writeFile(join(source, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(source, "legacy.txt"), "remove this file\n");
  const lockfileBytes = bytes('{"lockfileVersion":3}\n');
  await writeFile(join(source, "package-lock.json"), lockfileBytes);
  git(source, ["add", "-A"]);
  git(source, ["commit", "--quiet", "-m", "checkpoint base"]);
  const baseRevision = git(source, ["rev-parse", "HEAD"]);
  const baseIndex = git(source, ["rev-parse", `${baseRevision}:src/index.ts`]);
  const baseLegacy = git(source, ["rev-parse", `${baseRevision}:legacy.txt`]);

  await writeFile(join(source, "src", "index.ts"), "export const value = 2;\n");
  await rm(join(source, "legacy.txt"));
  const binaryBytes = Uint8Array.from([0, 1, 2, 255]);
  await writeFile(join(source, "assets", "payload.bin"), binaryBytes);
  if (options.symlinkTarget !== undefined) {
    await symlink(options.symlinkTarget, join(source, "escape"));
  }
  git(source, ["add", "-A"]);
  git(source, ["commit", "--quiet", "-m", "checkpoint result"]);
  const resultRevision = git(source, ["rev-parse", "HEAD"]);
  const gitTreeId = git(source, ["rev-parse", `${resultRevision}^{tree}`]);
  const resultIndex = git(source, ["rev-parse", `${resultRevision}:src/index.ts`]);
  const resultBinary = git(source, ["rev-parse", `${resultRevision}:assets/payload.bin`]);

  const bundlePath = join(root, "checkpoint.bundle");
  git(source, ["bundle", "create", bundlePath, "--all"]);
  const gitObjectBundle = await publishArtifact(
    store,
    await readFile(bundlePath),
    "application/vnd.git.bundle",
  );
  const validationEvidence = await publishArtifact(store, bytes("validated"), "text/plain");
  const lockfileArtifact = await publishArtifact(store, lockfileBytes, "application/json");
  const checkpoint: TaskCheckpointV1 = {
    schemaVersion: 1,
    runId: "run-workspace",
    manifestDigest: sha256Digest("manifest"),
    artifacts: [gitObjectBundle, validationEvidence, lockfileArtifact],
    gitTreeId,
    baseRevision,
    changes: [
      {
        path: "assets/payload.bin",
        change: "added",
        binary: true,
        resultBlobOid: resultBinary,
        resultMode: "100644",
      },
      {
        path: "legacy.txt",
        change: "deleted",
        binary: false,
        baseBlobOid: baseLegacy,
        baseMode: "100644",
      },
      {
        path: "src/index.ts",
        change: "modified",
        binary: false,
        baseBlobOid: baseIndex,
        resultBlobOid: resultIndex,
        baseMode: "100644",
        resultMode: "100644",
      },
      ...(options.symlinkTarget !== undefined
        ? [{
            path: "escape",
            change: "added" as const,
            binary: false,
            resultBlobOid: git(source, ["rev-parse", `${resultRevision}:escape`]),
            resultMode: "120000",
          }]
        : []),
    ],
    gitObjectIds: [...new Set(git(source, [
      "rev-list",
      "--objects",
      "--no-object-names",
      baseRevision,
      resultRevision,
    ]).split("\n"))],
    gitObjectBundle,
    validationEvidence: [validationEvidence],
    toolchain: [{ name: "Node.js", version: process.version }],
    dependencyLockfiles: [{ path: "package-lock.json", artifact: lockfileArtifact }],
  };
  const published = await store.publishCheckpoint(checkpoint);
  assert.ok(published.ok);
  return { root, source, store, checkpoint, digest: published.digest };
}

async function removeFixture(fixture: CheckpointFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

test("reconstructs the explicit checkpoint tree without importing the source's dirty files", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.source, "old-worker-uncommitted.txt"), "must not be resumed\n");
    let provisionedPath = "";
    const store: WorkspaceCheckpointStore = fixture.store;
    const reconstructor = new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "workspaces"),
      store,
      provisionDependencies: async ({ workspacePath, lockfiles }) => {
        provisionedPath = workspacePath;
        assert.equal(lockfiles.length, 1);
        assert.equal(lockfiles[0]?.path, "package-lock.json");
      },
    });
    const result = await reconstructor.reconstruct({
      checkpointDigest: fixture.digest,
      provisionDependencies: true,
    });
    assert.ok(result.ok);
    assert.equal(result.workspace.dependencies, "provisioned");
    assert.equal(provisionedPath, result.workspace.path);
    assert.equal(git(result.workspace.path, ["rev-parse", "HEAD"]), fixture.checkpoint.baseRevision);
    assert.equal(
      git(result.workspace.path, ["write-tree"]),
      git(fixture.source, ["rev-parse", `${fixture.checkpoint.baseRevision}^{tree}`]),
    );
    assert.equal(git(result.workspace.path, ["diff", "--cached", "--name-only"]), "");
    assert.deepEqual(
      git(result.workspace.path, ["diff", "--name-only"]).split("\n").sort(),
      ["legacy.txt", "src/index.ts"],
    );
    assert.deepEqual(
      git(result.workspace.path, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
      ["assets/payload.bin"],
    );
    assert.equal(await readFile(join(result.workspace.path, "src", "index.ts"), "utf8"), "export const value = 2;\n");
    assert.deepEqual(await readFile(join(result.workspace.path, "assets", "payload.bin")), Buffer.from([0, 1, 2, 255]));
    assert.equal(await readFile(join(result.workspace.path, "package-lock.json"), "utf8"), '{"lockfileVersion":3}\n');
    await assert.rejects(readFile(join(result.workspace.path, "old-worker-uncommitted.txt")));
    await assert.rejects(readFile(join(result.workspace.path, "legacy.txt")));
    await reconstructor.destroy(result.workspace);
    await assert.rejects(readFile(result.workspace.path));
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects checkpoint change metadata that does not match imported Git trees", async () => {
  const fixture = await createFixture();
  try {
    const corruptCheckpoint = {
      ...fixture.checkpoint,
      changes: fixture.checkpoint.changes.map((change) =>
        change.path === "src/index.ts" ? { ...change, path: "src/wrong.ts" } : change),
    };
    const published = await fixture.store.publishCheckpoint(corruptCheckpoint);
    assert.ok(published.ok);
    const reconstructor = new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "workspaces"),
      store: fixture.store,
    });
    await assert.rejects(
      reconstructor.reconstruct({ checkpointDigest: published.digest }),
      /Checkpoint change paths, modes, blob IDs, or binary flags do not match/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects checkpoints that omit objects required by the base tree", async () => {
  const fixture = await createFixture();
  try {
    const baseTreeId = git(fixture.source, ["rev-parse", `${fixture.checkpoint.baseRevision}^{tree}`]);
    const incompleteCheckpoint = {
      ...fixture.checkpoint,
      gitObjectIds: fixture.checkpoint.gitObjectIds.filter((oid) => oid !== baseTreeId),
    };
    const published = await fixture.store.publishCheckpoint(incompleteCheckpoint);
    assert.ok(published.ok);
    const reconstructor = new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "workspaces"),
      store: fixture.store,
    });
    await assert.rejects(
      reconstructor.reconstruct({ checkpointDigest: published.digest }),
      /gitObjectIds omit required Git objects/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects checkpoint symlinks that escape the isolated workspace", async () => {
  const fixture = await createFixture({ symlinkTarget: "../../outside" });
  try {
    const reconstructor = new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "workspaces"),
      store: fixture.store,
    });
    await assert.rejects(
      reconstructor.reconstruct({ checkpointDigest: fixture.digest }),
      /symlink that escapes or is invalid/,
    );
    assert.deepEqual(await readdir(join(fixture.root, "workspaces")), []);
  } finally {
    await removeFixture(fixture);
  }
});

test("resolves only explicitly bound credentials for the selected repository, target, and harness", async () => {
  const requests: WorkspaceSecretResolveRequest[] = [];
  const environment = await resolveWorkspaceCredentialEnvironment(
    {
      repositoryId: "repo-1",
      targetRef: "refs/heads/main",
      harnessId: "copilot",
      secretRefs: {
        token: { ref: "secret://repo-1/token", version: "7" },
        unused: { ref: "secret://repo-1/unused" },
      },
      bindings: [{ secretName: "token", environmentVariable: "COPILOT_TOKEN" }],
    },
    {
      async resolve(request) {
        requests.push(request);
        return "scoped-secret";
      },
    },
  );
  assert.deepEqual({ ...environment }, { COPILOT_TOKEN: "scoped-secret" });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    repositoryId: "repo-1",
    targetRef: "refs/heads/main",
    harnessId: "copilot",
    secretName: "token",
    reference: { ref: "secret://repo-1/token", version: "7" },
  });
  await assert.rejects(
    resolveWorkspaceCredentialEnvironment(
      {
        repositoryId: "repo-1",
        targetRef: "refs/heads/main",
        harnessId: "copilot",
        secretRefs: { token: { ref: "secret://repo-1/token" } },
        bindings: [{ secretName: "token", environmentVariable: "GIT_DIR" }],
      },
      { resolve: async () => "scoped-secret" },
    ),
    /reserved or invalid/,
  );
});

test("reports checkpoint lookup failures and refuses unscoped dependency provisioning", async () => {
  const fixture = await createFixture();
  try {
    const missingStore: WorkspaceCheckpointStore = {
      async resolveCheckpoint(): Promise<TaskCheckpointResult> {
        return { ok: false, code: "checkpoint-missing", failures: [] };
      },
      resolveArtifact: fixture.store.resolveArtifact.bind(fixture.store),
    };
    const missing = await new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "missing-workspaces"),
      store: missingStore,
    }).reconstruct({ checkpointDigest: fixture.digest });
    assert.deepEqual(missing, { ok: false, code: "checkpoint-missing", failures: [] });

    const reconstructor = new CheckpointWorkspaceReconstructor({
      workspaceRoot: join(fixture.root, "no-provisioner"),
      store: fixture.store,
    });
    await assert.rejects(
      reconstructor.reconstruct({
        checkpointDigest: fixture.digest,
        provisionDependencies: true,
      }),
      /no workspace-scoped provisioner/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("captures a dirty workspace as a checkpoint that reconstructs the same tree elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-capture-test-"));
  try {
    const source = join(root, "source");
    const store = new FileArtifactCheckpointStore(join(root, "artifact-store"));
    await mkdir(join(source, "src"), { recursive: true });
    git(root, ["init", "--quiet", "--initial-branch=main", source]);
    git(source, ["config", "user.name", "MyForge test"]);
    git(source, ["config", "user.email", "myforge-test@example.invalid"]);
    await writeFile(join(source, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(source, "legacy.txt"), "remove this file\n");
    await writeFile(join(source, ".gitignore"), "node_modules/\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "--quiet", "-m", "base"]);
    const baseRevision = git(source, ["rev-parse", "HEAD"]);

    await writeFile(join(source, "src", "index.ts"), "export const value = 2;\n");
    await rm(join(source, "legacy.txt"));
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "assets", "payload.bin"), Uint8Array.from([0, 1, 2, 255]));
    await writeFile(join(source, "package-lock.json"), '{"lockfileVersion":3}\n');
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "ignored.js"), "ignored\n");
    git(source, ["add", "src/index.ts"]);
    const indexBefore = git(source, ["diff", "--cached", "--name-only"]);
    const refsBefore = git(source, ["for-each-ref"]);

    const evidence = await publishArtifact(store, bytes("tests passed"), "text/plain");
    const captured = await captureWorkspaceCheckpoint({
      workspacePath: source,
      baseRevision,
      runId: "run-capture",
      manifestDigest: sha256Digest("manifest"),
      publisher: store,
      validationEvidence: [evidence],
      toolchain: [{ name: "Node.js", version: process.version }],
      dependencyLockfilePaths: ["package-lock.json"],
      commitDate: "2026-01-01T00:00:00Z",
    });
    assert.ok(captured.ok, JSON.stringify(captured));
    assert.equal(git(source, ["diff", "--cached", "--name-only"]), indexBefore);
    assert.equal(git(source, ["for-each-ref"]), refsBefore);
    assert.equal(git(source, ["rev-parse", "HEAD"]), baseRevision);
    assert.equal(git(source, ["rev-parse", `${captured.resultCommit}^`]), baseRevision);
    assert.equal(git(source, ["rev-parse", `${captured.resultCommit}^{tree}`]), captured.checkpoint.gitTreeId);
    assert.deepEqual(
      captured.checkpoint.changes.map((change) => [change.path, change.change, change.binary]),
      [
        ["assets/payload.bin", "added", true],
        ["legacy.txt", "deleted", false],
        ["package-lock.json", "added", false],
        ["src/index.ts", "modified", false],
      ],
    );
    assert.deepEqual(captured.checkpoint.validationEvidence, [evidence]);
    assert.deepEqual(captured.checkpoint.dependencyLockfiles.map((lockfile) => lockfile.path), ["package-lock.json"]);

    await writeFile(join(source, "after-capture.txt"), "not part of the checkpoint\n");
    const reconstructor = new CheckpointWorkspaceReconstructor({ workspaceRoot: join(root, "workspaces"), store });
    const rebuilt = await reconstructor.reconstruct({ checkpointDigest: captured.digest });
    assert.ok(rebuilt.ok, JSON.stringify(rebuilt));
    git(rebuilt.workspace.path, ["add", "-A"]);
    assert.equal(git(rebuilt.workspace.path, ["write-tree"]), captured.checkpoint.gitTreeId);
    assert.deepEqual(
      await readFile(join(rebuilt.workspace.path, "assets", "payload.bin")),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(git(rebuilt.workspace.path, ["cat-file", "-t", captured.resultCommit]), "commit");
    await assert.rejects(readFile(join(rebuilt.workspace.path, "after-capture.txt")), /ENOENT/);
    await assert.rejects(readFile(join(rebuilt.workspace.path, "node_modules", "ignored.js")), /ENOENT/);

    const again = await captureWorkspaceCheckpoint({
      workspacePath: rebuilt.workspace.path,
      baseRevision,
      runId: "run-capture",
      manifestDigest: sha256Digest("manifest"),
      publisher: store,
      validationEvidence: [evidence],
      toolchain: [{ name: "Node.js", version: process.version }],
      dependencyLockfilePaths: ["package-lock.json"],
      commitDate: "2026-01-01T00:00:00Z",
    });
    assert.ok(again.ok);
    assert.equal(again.checkpoint.gitTreeId, captured.checkpoint.gitTreeId);
    assert.equal(again.resultCommit, captured.resultCommit);

    await assert.rejects(
      captureWorkspaceCheckpoint({
        workspacePath: source,
        baseRevision,
        runId: "run-capture",
        manifestDigest: sha256Digest("manifest"),
        publisher: store,
        validationEvidence: [evidence],
        dependencyLockfilePaths: ["node_modules/ignored.js"],
      }),
      /not a regular file in the captured tree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
