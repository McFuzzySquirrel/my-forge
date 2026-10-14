import assert from "node:assert/strict";
import test from "node:test";
import { isTaskCompletionEvidence, createTaskCompletionEvidence } from "../../orchestration/outcome.ts";

const DIGEST = `sha256:${"b".repeat(64)}` as const;

test("completion evidence is digest-checked and bound to one operation identity", () => {
  const evidence = createTaskCompletionEvidence({
    runId: "run-1",
    taskId: "task-1",
    manifestDigest: DIGEST,
    logicalAttempt: 2,
    operationId: "22222222-2222-4222-8222-222222222222",
    outputFiles: ["src/result.ts"],
    handoffDigest: DIGEST,
    artifactRefs: [],
    validationCommands: ["npm test"],
  });

  assert.equal(isTaskCompletionEvidence(evidence, {
    runId: "run-1",
    taskId: "task-1",
    manifestDigest: DIGEST,
    logicalAttempt: 2,
    operationId: "22222222-2222-4222-8222-222222222222",
  }), true);
  assert.equal(isTaskCompletionEvidence(evidence, {
    runId: "run-1",
    taskId: "task-1",
    manifestDigest: DIGEST,
    operationId: "33333333-3333-4333-8333-333333333333",
  }), false);
  assert.equal(isTaskCompletionEvidence({
    ...evidence,
    gates: { ...evidence.gates, validation: { status: "failed", evidence: ["npm test"] } },
  }), false);
});
