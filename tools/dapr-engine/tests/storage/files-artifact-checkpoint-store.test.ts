import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Digest, type ArtifactRefV1, type TaskCheckpointV1 } from "../../contract/v1/index.ts";
import { FileArtifactCheckpointStore } from "../../storage/index.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function inStore(run: (root: string, store: FileArtifactCheckpointStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "myforge-artifact-store-"));
  try {
    await run(root, new FileArtifactCheckpointStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

async function checkpointFixture(store: FileArtifactCheckpointStore): Promise<TaskCheckpointV1> {
  const bundle = await publishArtifact(store, bytes("git object bundle"), "application/vnd.git.bundle");
  const validation = await publishArtifact(store, bytes("validation passed"), "text/plain");
  const lockfile = await publishArtifact(store, bytes('{"dependencies":{}}'), "application/json");
  const baseRevision = "a".repeat(40);
  const treeId = "b".repeat(40);
  const modifiedBase = "c".repeat(40);
  const modifiedResult = "d".repeat(40);
  const addedResult = "e".repeat(40);
  return {
    schemaVersion: 1,
    runId: "run-a",
    manifestDigest: sha256Digest("manifest"),
    artifacts: [bundle, validation, lockfile],
    gitTreeId: treeId,
    baseRevision,
    changes: [
      {
        path: "src/index.ts",
        change: "modified",
        binary: false,
        baseBlobOid: modifiedBase,
        resultBlobOid: modifiedResult,
        baseMode: "100644",
        resultMode: "100644",
      },
      {
        path: "assets/logo.bin",
        change: "added",
        binary: true,
        resultBlobOid: addedResult,
        resultMode: "100644",
      },
      {
        path: "old/deleted.ts",
        change: "deleted",
        binary: false,
        baseBlobOid: "f".repeat(40),
        baseMode: "100755",
      },
    ],
    gitObjectIds: [baseRevision, treeId, modifiedBase, modifiedResult, addedResult, "f".repeat(40)],
    gitObjectBundle: bundle,
    validationEvidence: [validation],
    toolchain: [{ name: "Node.js", version: "24.11.1" }],
    dependencyLockfiles: [{ path: "package-lock.json", artifact: lockfile }],
  };
}

test("artifacts are immutable, content-addressed, and verified on publish and resolve", async () => {
  await inStore(async (root, store) => {
    const content = bytes("task output");
    const ref = await publishArtifact(store, content, "text/plain");
    const [duplicateA, duplicateB] = await Promise.all([
      store.publishArtifact(content, { mediaType: "text/plain", sizeBytes: content.byteLength, sha256: sha256Digest(content) }),
      store.publishArtifact(content, { mediaType: "text/plain", sizeBytes: content.byteLength, sha256: sha256Digest(content) }),
    ]);
    assert.ok(duplicateA.ok && duplicateB.ok);
    assert.equal(duplicateA.ref.uri, duplicateB.ref.uri);

    const sensitive = await store.publishArtifact(content, {
      mediaType: "text/plain",
      sizeBytes: content.byteLength,
      sha256: sha256Digest(content),
      sensitivity: "sensitive",
    });
    assert.ok(sensitive.ok);
    assert.notEqual(sensitive.ref.artifactId, ref.artifactId);
    assert.equal(sensitive.ref.uri, ref.uri);
    assert.ok((await store.resolveArtifact(sensitive.ref)).ok);

    const resolved = await store.resolveArtifact(ref);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.bytes, content);

    const objectPath = join(root, "objects", "sha256", ref.sha256.slice(7, 9), ref.sha256.slice(9));
    await writeFile(objectPath, bytes("corruptxxxx"));
    assert.deepEqual(await store.resolveArtifact(ref), { ok: false, code: "artifact-digest-mismatch" });
    assert.deepEqual(
      await store.publishArtifact(content, { mediaType: "text/plain", sizeBytes: content.byteLength, sha256: sha256Digest(content) }),
      { ok: false, code: "artifact-digest-mismatch" },
      "a corrupt content-addressed object is never overwritten",
    );

    const missing = await publishArtifact(store, bytes("will disappear"), "text/plain");
    const missingPath = join(root, "objects", "sha256", missing.sha256.slice(7, 9), missing.sha256.slice(9));
    await rm(missingPath);
    assert.deepEqual(await store.resolveArtifact(missing), { ok: false, code: "artifact-missing" });
    assert.deepEqual(
      await store.publishArtifact(content, { mediaType: "text/plain", sizeBytes: content.byteLength + 1, sha256: sha256Digest(content) }),
      { ok: false, code: "artifact-size-mismatch" },
    );
    const corruptedBytes = await readFile(join(root, "objects", "sha256", ref.sha256.slice(7, 9), ref.sha256.slice(9)));
    assert.ok(corruptedBytes.equals(Buffer.from(bytes("corruptxxxx"))));
  });
});

test("checkpoints publish only after referenced artifacts verify and fail closed on later corruption", async () => {
  await inStore(async (root, store) => {
    const checkpoint = await checkpointFixture(store);
    const published = await store.publishCheckpoint(checkpoint);
    assert.ok(published.ok);
    assert.equal(published.checkpoint.changes[1]?.binary, true);

    const recovered = await new FileArtifactCheckpointStore(root).resolveCheckpoint(published.digest);
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.checkpoint, checkpoint);

    const digestPath = join(root, "checkpoints", "sha256", published.digest.slice(7, 9), `${published.digest.slice(9)}.json`);
    const checkpointBytes = await readFile(digestPath, "utf8");
    assert.equal(sha256Digest(checkpointBytes), published.digest);

    const damagedArtifact = checkpoint.gitObjectBundle;
    const objectPath = join(root, "objects", "sha256", damagedArtifact.sha256.slice(7, 9), damagedArtifact.sha256.slice(9));
    await writeFile(objectPath, bytes("xxxxxxxxxxxxxxxxx"));
    const failedRecovery = await store.resolveCheckpoint(published.digest);
    assert.ok(!failedRecovery.ok && failedRecovery.code === "checkpoint-integrity-failure");
    assert.ok(failedRecovery.failures.some((failure) => failure.includes("artifact-digest-mismatch")));
  });
});

test("checkpoint publication rejects unsafe paths and missing required artifacts", async () => {
  await inStore(async (root, store) => {
    const checkpoint = await checkpointFixture(store);
    const missingBundle = { ...checkpoint, gitObjectBundle: { ...checkpoint.gitObjectBundle, sha256: sha256Digest("missing") } };
    const missingResult = await store.publishCheckpoint(missingBundle);
    assert.ok(!missingResult.ok && missingResult.code === "checkpoint-integrity-failure");

    const bundlePath = join(
      root,
      "objects",
      "sha256",
      checkpoint.gitObjectBundle.sha256.slice(7, 9),
      checkpoint.gitObjectBundle.sha256.slice(9),
    );
    await rm(bundlePath);
    const unavailableArtifact = await store.publishCheckpoint(checkpoint);
    assert.ok(!unavailableArtifact.ok && unavailableArtifact.code === "checkpoint-integrity-failure");
    assert.ok(unavailableArtifact.failures.some((failure) => failure.includes("artifact-missing")));

    const unsafeChange = {
      ...checkpoint.changes[0]!,
      path: "../outside.txt",
    };
    const unsafeResult = await store.publishCheckpoint({ ...checkpoint, changes: [unsafeChange] });
    assert.ok(!unsafeResult.ok && unsafeResult.code === "checkpoint-integrity-failure");
    assert.ok(unsafeResult.failures.some((failure) => failure.includes("unsafe change path")));
  });
});
