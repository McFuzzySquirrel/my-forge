import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import { ArtifactStore } from "../../execution/artifacts.ts";
import { FileTaskCompletionStore } from "../../execution/task-completions.ts";
import type { ArtifactRefV1 } from "../../contract/v1/index.ts";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "MyForge test",
      GIT_AUTHOR_EMAIL: "myforge-test@example.invalid",
      GIT_COMMITTER_NAME: "MyForge test",
      GIT_COMMITTER_EMAIL: "myforge-test@example.invalid",
    },
  }).trim();
}

function ref(bytes: Buffer, artifactId: string): ArtifactRefV1 {
  return {
    schemaVersion: 1,
    artifactId,
    uri: `myforge://artifact/${artifactId}`,
    mediaType: "application/json",
    sizeBytes: bytes.byteLength,
    sha256: sha256Digest(bytes),
    retentionClass: "checkpoint-evidence",
  };
}

test("records, resolves, and hydrates an integrated task completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-completions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(repository, "README.md"), "base\n");
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["commit", "--quiet", "--allow-empty", "-m", "later"]);
  const head = git(repository, ["rev-parse", "HEAD"]);

  const artifact = {
    schemaVersion: 1,
    artifactId: "work-fnd-01-001",
    type: "work.fnd-01",
    category: "work",
    taskId: "FND-01",
    producedBy: "infrastructure-engineer",
    status: "complete",
    summary: "Scaffolded the application and verified it.",
    filesChanged: ["package.json"],
    payload: { taskDescription: "Scaffold" },
    inputs: [],
    nextActions: [],
    createdAt: "2026-10-24T00:00:00.000Z",
  } as const;
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  const workArtifact = ref(artifactBytes, artifact.artifactId);
  const validationArtifact = ref(Buffer.from("{}\n"), "validation-001");
  const bundleArtifact = ref(Buffer.from("bundle"), "bundle-001");
  const store = new FileTaskCompletionStore(join(root, "completions"));

  await store.record({
    schemaVersion: 1,
    repositoryId: "repo_test",
    targetRef: "refs/heads/forge/main",
    taskId: "FND-01",
    runId: `run_${"a".repeat(32)}`,
    commitSha: baseRevision,
    baseRevision,
    checkpointDigest: `sha256:${"1".repeat(64)}`,
    workArtifact,
    validationArtifact,
    bundleArtifact,
    outputFiles: ["package.json"],
    validationCommands: ["npm run build"],
    handoffDigest: `sha256:${"2".repeat(64)}`,
    completedAt: "2026-10-24T00:01:00.000Z",
  });

  const resolved = await store.resolve({
    repositoryId: "repo_test",
    taskId: "FND-01",
    repositoryRoot: repository,
    head,
  });
  assert.equal(resolved?.commitSha, baseRevision);
  assert.equal(resolved?.workArtifact?.artifactId, workArtifact.artifactId);

  const artifactStore = new ArtifactStore({ artifactsPath: join(root, "run-artifacts") });
  await store.hydrate(artifactStore, {
    repositoryId: "repo_test",
    repositoryRoot: repository,
    head,
    taskIds: ["FND-01"],
    resolveArtifact: async (requested) => {
      if (requested.artifactId === workArtifact.artifactId) return { ok: true, bytes: artifactBytes };
      return { ok: false, code: "artifact-missing" };
    },
  });

  const hydrated = artifactStore.readByTask("FND-01");
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0]?.summary, artifact.summary);
  const projection = artifactStore.project({ taskId: "FND-02", inputTypes: ["work.fnd-01"] });
  assert.equal(projection.artifacts.length, 1);
  assert.equal(projection.artifacts[0]?.summary, artifact.summary);
  assert.deepEqual(await readFile(join(root, "run-artifacts", "work-fnd-01", "work-fnd-01-001.json"), "utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
});

test("does not resolve a completion that is not an ancestor of the run head", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-completions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(repository, "README.md"), "base\n");
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--quiet", "-b", "other"]);
  git(repository, ["commit", "--quiet", "--allow-empty", "-m", "other"]);
  const other = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--quiet", "main"]);
  git(repository, ["commit", "--quiet", "--allow-empty", "-m", "main"]);
  const head = git(repository, ["rev-parse", "HEAD"]);

  const empty = Buffer.from("{}\n");
  const store = new FileTaskCompletionStore(join(root, "completions"));
  await store.record({
    schemaVersion: 1,
    repositoryId: "repo_test",
    targetRef: "refs/heads/forge/main",
    taskId: "FND-01",
    runId: `run_${"a".repeat(32)}`,
    commitSha: other,
    baseRevision: other,
    checkpointDigest: `sha256:${"1".repeat(64)}`,
    validationArtifact: ref(empty, "validation-001"),
    bundleArtifact: ref(empty, "bundle-001"),
    outputFiles: [],
    validationCommands: [],
    handoffDigest: `sha256:${"2".repeat(64)}`,
    completedAt: "2026-10-24T00:01:00.000Z",
  });

  assert.equal(await store.resolve({
    repositoryId: "repo_test",
    taskId: "FND-01",
    repositoryRoot: repository,
    head,
  }), undefined);
  assert.equal(await store.resolve({
    repositoryId: "repo_test",
    taskId: "FND-01",
    repositoryRoot: repository,
    head: baseRevision,
  }), undefined);
});
