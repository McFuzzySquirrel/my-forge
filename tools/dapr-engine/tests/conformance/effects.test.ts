// Contract v1 §3 conformance: receipts, artifacts, checkpoints, fencing, retention.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SCHEMA_VERSION, planRetention, sha256Digest, type CheckpointV1, type OperationKeyV1 } from "../../contract/v1/index.ts";
import {
  ManualClock,
  ReferenceArtifactStore,
  ReferenceCheckpointStore,
  ReferenceExecutionService,
  ReferenceIntegrationAuthority,
  ReferenceReceiptStore,
} from "./support/reference-model.ts";
import { submission } from "./support/fixtures.ts";

const key = (): OperationKeyV1 => ({ runId: "run_a", taskId: "T1", logicalAttempt: 1, operationId: randomUUID() });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("C11: activity redelivery reuses the receipt and cannot publish a conflicting accepted effect", () => {
  const receipts = new ReferenceReceiptStore();
  const operation = key();
  const effectA = sha256Digest("patch A");
  const effectB = sha256Digest("patch B");

  const claimed = receipts.claim(operation);
  assert.ok(claimed.ok && !claimed.reused);
  const executing = receipts.transition(operation, 1, "executing");
  assert.ok(executing.ok);
  const published = receipts.transition(operation, 2, "effect-published", { effectDigest: effectA });
  assert.ok(published.ok);

  const redelivered = receipts.claim(operation);
  assert.ok(redelivered.ok && redelivered.reused);
  assert.equal(redelivered.receipt.state, "effect-published");
  assert.deepEqual(receipts.transition(operation, 3, "accepted", { effectDigest: effectB }), { ok: false, code: "conflicting-effect" });

  const accepted = receipts.transition(operation, 3, "accepted", { effectDigest: effectA });
  assert.ok(accepted.ok && accepted.receipt.effectDigest === effectA);
  const lateRedelivery = receipts.claim(operation);
  assert.ok(lateRedelivery.ok && lateRedelivery.reused && lateRedelivery.receipt.state === "accepted");
  assert.equal(receipts.all().length, 1);
});

test("C12: a stale receipt revision or invalid transition is rejected by compare-and-set", () => {
  const receipts = new ReferenceReceiptStore();
  const operation = key();
  receipts.claim(operation);
  assert.ok(receipts.transition(operation, 1, "executing").ok);
  assert.deepEqual(receipts.transition(operation, 1, "failed"), { ok: false, code: "stale-revision" });
  assert.deepEqual(receipts.transition(operation, 2, "accepted"), { ok: false, code: "invalid-transition" });
  assert.deepEqual(receipts.transition(operation, 2, "claimed"), { ok: false, code: "invalid-transition" });
  assert.deepEqual(receipts.transition(operation, 2, "effect-published"), { ok: false, code: "missing-effect-digest" });
  assert.equal(receipts.get(operation)?.state, "executing");
  assert.equal(receipts.get(operation)?.recordVersion, 2);
});

test("C20: an ambiguous receipt cannot be retried as a fresh effect and only reconciles to accepted or failed", () => {
  const receipts = new ReferenceReceiptStore();
  const operation = key();
  receipts.claim(operation);
  receipts.transition(operation, 1, "executing");
  assert.ok(receipts.transition(operation, 2, "ambiguous", { diagnosticRef: "diag://timeout" }).ok);
  assert.deepEqual(receipts.transition(operation, 3, "executing"), { ok: false, code: "invalid-transition" });
  const redelivered = receipts.claim(operation);
  assert.ok(redelivered.ok && redelivered.reused && redelivered.receipt.state === "ambiguous");
  const reconciled = receipts.transition(operation, 3, "accepted", { effectDigest: sha256Digest("observed patch") });
  assert.ok(reconciled.ok);
  assert.deepEqual(reconciled.receipt.diagnosticRefs, ["diag://timeout"]);
});

test("C13: artifact bytes that do not match the declared digest or size are rejected on publish and resolve", () => {
  const artifacts = new ReferenceArtifactStore();
  const content = bytes("task report");
  const mediaType = "application/json";

  assert.deepEqual(artifacts.publish(content, { mediaType, sizeBytes: content.byteLength, sha256: sha256Digest("other") }),
    { ok: false, code: "artifact-digest-mismatch" });
  assert.deepEqual(artifacts.publish(content, { mediaType, sizeBytes: content.byteLength + 1, sha256: sha256Digest(content) }),
    { ok: false, code: "artifact-size-mismatch" });
  assert.deepEqual(artifacts.publish(new Uint8Array(), { mediaType, sizeBytes: 0, sha256: sha256Digest(content) }),
    { ok: false, code: "artifact-digest-mismatch" }, "empty output is not success-shaped");

  const published = artifacts.publish(content, { mediaType, sizeBytes: content.byteLength, sha256: sha256Digest(content) });
  assert.ok(published.ok);
  const resolved = artifacts.resolve(published.ref);
  assert.ok(resolved.ok && new TextDecoder().decode(resolved.bytes) === "task report");

  artifacts.corruptForTest(published.ref, bytes("task repORT"));
  assert.deepEqual(artifacts.resolve(published.ref), { ok: false, code: "artifact-digest-mismatch" });
  artifacts.delete(published.ref);
  assert.deepEqual(artifacts.resolve(published.ref), { ok: false, code: "artifact-missing" });
});

function checkpointFixture() {
  const artifacts = new ReferenceArtifactStore();
  const checkpoints = new ReferenceCheckpointStore(artifacts);
  const content = bytes("diff --git a/x b/x");
  const published = artifacts.publish(content, { mediaType: "text/x-diff", sizeBytes: content.byteLength, sha256: sha256Digest(content) });
  assert.ok(published.ok);
  const checkpoint: CheckpointV1 = {
    schemaVersion: SCHEMA_VERSION,
    runId: "run_a",
    manifestDigest: sha256Digest("manifest"),
    artifacts: [published.ref],
    gitTreeId: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  };
  return { artifacts, checkpoints, checkpoint, ref: published.ref };
}

test("C14: a checkpoint referencing an unpublished or corrupt artifact stays unavailable with an integrity failure", () => {
  const { artifacts, checkpoints, checkpoint, ref } = checkpointFixture();
  const unpublished = { ...ref, artifactId: "art_unpublished", uri: "memory://artifacts/sha256/missing", sha256: sha256Digest("never written") };
  const rejected = checkpoints.publish({ ...checkpoint, artifacts: [ref, unpublished] });
  assert.equal(!rejected.ok && rejected.code, "checkpoint-integrity-failure");
  assert.deepEqual(checkpoints.recoverable("run_a"), []);

  const published = checkpoints.publish(checkpoint);
  assert.ok(published.ok);
  assert.deepEqual(checkpoints.recoverable("run_a"), [published.digest]);

  artifacts.corruptForTest(ref, bytes("tampered"));
  const resolved = checkpoints.resolve(published.digest);
  assert.equal(!resolved.ok && resolved.code, "checkpoint-integrity-failure");
  assert.deepEqual(!resolved.ok && resolved.failures, [`${ref.artifactId}: artifact-size-mismatch`]);
  assert.deepEqual(checkpoints.recoverable("run_a"), [], "a corrupt checkpoint is never an empty successful recovery point");
});

test("C15: an expired fencing token is rejected even while workflow status still reports the task running", () => {
  const clock = new ManualClock();
  const service = new ReferenceExecutionService(clock);
  const run = service.submit(submission());
  assert.ok(run.ok);
  const dispatched = service.dispatchNext(run.runId)!;
  const authority = new ReferenceIntegrationAuthority(clock);
  const lease = authority.acquire("repo_fixture", "refs/heads/main", run.runId, 30_000);
  assert.ok(lease.ok);

  clock.advance(30_000);
  const result = authority.accept({
    repositoryId: "repo_fixture", targetRef: "refs/heads/main", fencingToken: lease.lease.fencingToken,
    runId: run.runId, taskId: dispatched.taskId, logicalAttempt: dispatched.logicalAttempt,
    operationId: dispatched.operationId, commitSha: "a".repeat(40),
  });
  assert.equal(service.status(run.runId)?.tasks.T1.status, "running");
  assert.deepEqual(result, { ok: false, code: "expired-fencing-token" });
  assert.deepEqual(authority.accepted, []);
});

test("C21: a stale owner cannot integrate after a newer token, and each logical attempt integrates once", () => {
  const clock = new ManualClock();
  const authority = new ReferenceIntegrationAuthority(clock);
  const scope = { repositoryId: "repo_fixture", targetRef: "refs/heads/main" };
  const first = authority.acquire(scope.repositoryId, scope.targetRef, "run_a", 10_000);
  assert.ok(first.ok);
  assert.deepEqual(authority.acquire(scope.repositoryId, scope.targetRef, "run_b", 10_000), { ok: false, code: "lease-held" });

  clock.advance(10_000);
  const second = authority.acquire(scope.repositoryId, scope.targetRef, "run_b", 10_000);
  assert.ok(second.ok && second.lease.fencingToken > first.lease.fencingToken);

  const stale = authority.accept({ ...scope, fencingToken: first.lease.fencingToken, runId: "run_a", taskId: "T1",
    logicalAttempt: 1, operationId: randomUUID(), commitSha: "a".repeat(40) });
  assert.deepEqual(stale, { ok: false, code: "stale-fencing-token" });

  const integration = { ...scope, fencingToken: second.lease.fencingToken, runId: "run_b", taskId: "T1",
    logicalAttempt: 1, operationId: randomUUID(), commitSha: "b".repeat(40) };
  assert.deepEqual(authority.accept(integration), { ok: true, commitSha: "b".repeat(40), reused: false });
  assert.deepEqual(authority.accept({ ...integration }), { ok: true, commitSha: "b".repeat(40), reused: true });
  assert.deepEqual(authority.accept({ ...integration, commitSha: "c".repeat(40), operationId: randomUUID() }),
    { ok: false, code: "conflicting-integration" });
  assert.equal(authority.accepted.length, 1);
});

test("C16: an expired terminal diagnostic referenced by a live checkpoint or review is retained", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");
  const week = 7 * 24 * 60 * 60 * 1000;
  const terminalAt = "2026-10-01T00:00:00.000Z";
  const plan = planRetention([
    { artifactId: "diag-referenced-by-checkpoint", retentionClass: "terminal-diagnostic", terminalAt },
    { artifactId: "diag-referenced-by-review", retentionClass: "terminal-diagnostic", terminalAt },
    { artifactId: "diag-unreferenced", retentionClass: "terminal-diagnostic", terminalAt },
    { artifactId: "diag-recent", retentionClass: "terminal-diagnostic", terminalAt: "2026-10-19T00:00:00.000Z" },
    { artifactId: "diag-live-run", retentionClass: "terminal-diagnostic" },
    { artifactId: "evidence", retentionClass: "checkpoint-evidence", terminalAt },
  ], new Set(["diag-referenced-by-checkpoint", "diag-referenced-by-review"]), now, week);

  assert.deepEqual(plan.deletable, ["diag-unreferenced"]);
  assert.deepEqual(plan.retained, [
    { artifactId: "diag-referenced-by-checkpoint", reason: "live-reference" },
    { artifactId: "diag-referenced-by-review", reason: "live-reference" },
    { artifactId: "diag-recent", reason: "not-expired" },
    { artifactId: "diag-live-run", reason: "not-terminal" },
    { artifactId: "evidence", reason: "evidence-class" },
  ]);
});
