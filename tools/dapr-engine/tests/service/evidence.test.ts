import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactRefV1 } from "../../contract/v1/index.ts";
import { CompletionEvidenceService } from "../../service/evidence.ts";
import type { TaskCompletionRecordV1 } from "../../execution/task-completions.ts";

const workArtifact: ArtifactRefV1 = {
  schemaVersion: 1 as const,
  artifactId: `art_${"a".repeat(64)}`,
  uri: `artifact://sha256/${"a".repeat(64)}`,
  mediaType: "application/json",
  sizeBytes: 12,
  sha256: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  retentionClass: "checkpoint-evidence" as const,
};

const record: TaskCompletionRecordV1 = {
  schemaVersion: 1,
  repositoryId: "repo_test",
  targetRef: "refs/heads/forge/main",
  taskId: "FND-02",
  runId: `run_${"b".repeat(32)}`,
  commitSha: "c".repeat(40),
  baseRevision: "d".repeat(40),
  checkpointDigest: `sha256:${"e".repeat(64)}`,
  workArtifact,
  validationArtifact: { ...workArtifact, artifactId: `art_${"f".repeat(64)}`, sha256: `sha256:${"f".repeat(64)}` },
  bundleArtifact: { ...workArtifact, artifactId: `art_${"1".repeat(64)}`, sha256: `sha256:${"1".repeat(64)}` },
  outputFiles: ["src/data/db.ts"],
  validationCommands: ["npm test"],
  handoffDigest: `sha256:${"2".repeat(64)}`,
  completedAt: "2026-10-24T00:00:00.000Z",
};

test("lists completion evidence scoped to a repository", async () => {
  const service = new CompletionEvidenceService(
    { list: async (repositoryId) => repositoryId === "repo_test" ? [record] : [] },
    { resolveArtifact: async () => ({ ok: true, bytes: Buffer.from("{}") }) },
  );
  const result = await service.list("repo_test");
  if (!result.ok) throw new Error(result.detail);
  const body = result.body as { count: number; tasks: Array<{ taskId: string }> };
  assert.equal(body.count, 1);
  assert.equal(body.tasks[0]?.taskId, "FND-02");
  const missing = await service.list("repo_other");
  if (!missing.ok) throw new Error(missing.detail);
  assert.equal((missing.body as { count: number }).count, 0);
});

test("resolves only artifacts listed by that repository's completions", async () => {
  const service = new CompletionEvidenceService(
    { list: async () => [record] },
    { resolveArtifact: async (ref) => ({ ok: true, bytes: Buffer.from(`{"artifact":"${ref.artifactId}"}`) }) },
  );
  const found = await service.artifact("repo_test", workArtifact.artifactId);
  if (!found.ok) throw new Error(found.detail);
  const body = found.body as { encoding: string; content: string };
  assert.equal(body.encoding, "base64");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), `{"artifact":"${workArtifact.artifactId}"}`);

  const foreign = await service.artifact("repo_test", `art_${"9".repeat(64)}`);
  assert.equal(foreign.ok, false);
  assert.equal(!foreign.ok && foreign.code, "artifact-not-found");
});
