// Contract v1 §1 conformance: run submission, identity, and immutable snapshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, computeManifestDigest, expandSelection } from "../../contract/v1/index.ts";
import { ReferenceExecutionService } from "./support/reference-model.ts";
import { control, sampleManifest, submission } from "./support/fixtures.ts";

test("C01: retrying the same repository, submission key, and canonical snapshot returns the same run", () => {
  const service = new ReferenceExecutionService();
  const request = submission();
  const first = service.submit(request);
  const reordered = JSON.parse(canonicalJson(request)) as typeof request;
  const retried = service.submit(reordered);

  assert.equal(first.ok && first.created, true);
  assert.deepEqual(retried, { ok: true, runId: first.ok ? first.runId : "", created: false });
  assert.equal(service.workflowCount, 1);
});

test("C02: reusing a submission key with a changed snapshot is a conflict that preserves the accepted run", () => {
  const service = new ReferenceExecutionService();
  const original = submission();
  const accepted = service.submit(original);
  assert.ok(accepted.ok);
  const before = service.storedSubmission(accepted.runId);

  const changedManifest = { ...sampleManifest(), note: "recompiled" };
  const variants = {
    branch: { targetRef: "refs/heads/feature" },
    digest: { manifestSnapshot: changedManifest, manifestDigest: computeManifestDigest(changedManifest) },
    selection: { selection: { mode: "manual" as const, requestedTaskIds: ["T2"] } },
    harness: { harness: { id: "copilot", adapterVersion: "1" } },
    definition: { workflowDefinitionVersion: "forge-run@1.1.0" },
  };
  for (const [name, change] of Object.entries(variants)) {
    const result = service.submit({ ...original, ...change });
    assert.equal(result.ok, false, name);
    assert.equal(!result.ok && result.code, "submission-conflict", name);
  }
  assert.deepEqual(service.storedSubmission(accepted.runId), before);
  assert.equal(service.workflowCount, 1);
});

test("C03: an incorrect manifest digest is rejected before run acceptance", () => {
  const service = new ReferenceExecutionService();
  const result = service.submit(submission({ manifestDigest: `sha256:${"0".repeat(64)}` }));
  assert.deepEqual(result.ok ? null : result.code, "manifest-digest-mismatch");
  assert.equal(service.workflowCount, 0);
});

test("C04: secret values are rejected before persistence and never appear in status or records", () => {
  const service = new ReferenceExecutionService();
  const secret = "sk-fixture-do-not-persist";
  const leaking = submission({
    configuration: { settings: { OPENAI_API_KEY: secret, maxRetries: 2 }, secretRefs: {} },
  });
  const nested = submission({
    configuration: { settings: { provider: { authToken: secret } }, secretRefs: {} },
  });

  for (const request of [leaking, nested]) {
    const result = service.submit(request);
    assert.equal(!result.ok && result.code, "secret-value-in-snapshot");
  }
  assert.equal(service.workflowCount, 0);
  assert.ok(!service.exportRecords().includes(secret));

  const accepted = service.submit(submission());
  assert.ok(accepted.ok, "secret references are allowed");
  assert.ok(!JSON.stringify(service.status(accepted.runId)).includes(secret));
});

test("C10: an unknown selected task or unresolved dependency rejects the run before any dispatch", () => {
  const service = new ReferenceExecutionService();
  const unknown = service.submit(submission({ selection: { mode: "manual", requestedTaskIds: ["T9"] } }));
  assert.equal(!unknown.ok && unknown.code, "unknown-selected-task");

  const dangling = { phases: [{ id: "P1", tasks: [{ id: "T1", dependencies: ["missing"] }] }] };
  const unresolved = service.submit(submission({ manifestSnapshot: dangling, manifestDigest: computeManifestDigest(dangling) }));
  assert.equal(!unresolved.ok && unresolved.code, "unresolved-dependency");

  const missingPhase = { phases: [{ id: "P1", dependencies: ["P0"], tasks: [{ id: "T1" }] }] };
  const phaseResult = service.submit(submission({ manifestSnapshot: missingPhase, manifestDigest: computeManifestDigest(missingPhase) }));
  assert.equal(!phaseResult.ok && phaseResult.code, "unresolved-dependency");
  assert.equal(service.workflowCount, 0);
});

test("C19: task selection is frozen with transitive prerequisites and cannot be mutated after acceptance", () => {
  const service = new ReferenceExecutionService();
  const accepted = service.submit(submission({ selection: { mode: "manual", requestedTaskIds: ["T3"] } }));
  assert.ok(accepted.ok);
  // T3 pulls in all of phase P1 (phase dependency) plus T1 (direct dependency).
  assert.deepEqual(service.status(accepted.runId)?.effectiveTaskIds, ["T1", "T2", "T3"]);

  const result = service.control(control(accepted.runId, "select-tasks", { taskIds: ["T4"] }));
  assert.ok(result.ok);
  assert.equal(result.record.state, "rejected");
  assert.equal(result.record.reasonCode, "selection-immutable");
  assert.deepEqual(service.storedSubmission(accepted.runId)?.selection.effectiveTaskIds, ["T1", "T2", "T3"]);
});

test("C22: the manifest digest is the SHA-256 of RFC 8785 canonical JSON and ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1e21, y: 0.000001 } }),
    '{"a":[true,null,"x"],"b":1,"c":{"y":0.000001,"z":1e+21}}');
  const manifest = sampleManifest();
  const reordered = { phases: manifest.phases, version: manifest.version };
  assert.equal(computeManifestDigest(reordered), computeManifestDigest(manifest));
  assert.match(computeManifestDigest(manifest), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => canonicalJson({ value: Number.NaN }));
  assert.throws(() => canonicalJson({ value: "\uD800" }));
});

test("selection expansion follows the legacy prerequisite rule in manifest order", () => {
  const all = expandSelection(sampleManifest(), "auto", []);
  assert.deepEqual(all, { ok: true, effectiveTaskIds: ["T1", "T2", "T3", "T4"] });
  const single = expandSelection(sampleManifest(), "manual", ["T2"]);
  assert.deepEqual(single, { ok: true, effectiveTaskIds: ["T1", "T2"] });
});
