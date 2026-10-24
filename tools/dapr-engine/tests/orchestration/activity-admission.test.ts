import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArtifactRefV1 } from "../../contract/v1/index.ts";
import { ArtifactStore } from "../../execution/artifacts.ts";
import { executeVerifiedTaskActivity, admitTaskActivityResult } from "../../orchestration/activity-admission.ts";
import { isTaskCompletionEvidence } from "../../orchestration/outcome.ts";
import type { AgentDescriptor, HarnessAdapter, ManifestTask, TaskResult } from "../../execution/types.ts";

const DIGEST = `sha256:${"c".repeat(64)}` as const;

function fixtureTask(expectedOutputs = ["src/output.ts"]): ManifestTask {
  return {
    id: "TASK-1",
    title: "Implement task",
    description: "Implement the required behavior.",
    dependencies: [],
    expectedOutputs,
    validationCommands: ["node --version"],
    approvalRequired: false,
    sourceLines: [],
  };
}

function successfulResult(): TaskResult {
  return {
    success: true,
    outputFiles: [],
    stdout: `\`\`\`forge-result\n${JSON.stringify({
      summary: "Implemented the requested behavior and validated its required output.",
      unresolved: [],
    })}\n\`\`\``,
    stderr: "",
    durationMs: 1,
  };
}

test("activity admission converts verified execution into an identity-bound complete outcome", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "myforge-activity-admission-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "output.ts"), "export const output = true;\n");

  const outcome = await admitTaskActivityResult({
    runId: "run-1",
    taskId: "TASK-1",
    manifestDigest: DIGEST,
    logicalAttempt: 2,
    operationId: "22222222-2222-4222-8222-222222222222",
    task: fixtureTask(),
    result: successfulResult(),
    repoRoot,
    baseline: null,
    allowNoop: false,
    timeoutMs: 5_000,
    artifactRefs: [],
  });

  assert.equal(outcome.status, "complete");
  if (outcome.status !== "complete") return;
  assert.equal(isTaskCompletionEvidence(outcome.evidence, {
    runId: "run-1",
    taskId: "TASK-1",
    manifestDigest: DIGEST,
    logicalAttempt: 2,
    operationId: "22222222-2222-4222-8222-222222222222",
  }), true);
});

test("activity admission never returns complete when verification fails", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "myforge-activity-admission-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const outcome = await admitTaskActivityResult({
    runId: "run-1",
    taskId: "TASK-1",
    manifestDigest: DIGEST,
    logicalAttempt: 1,
    operationId: "11111111-1111-4111-8111-111111111111",
    task: fixtureTask(),
    result: successfulResult(),
    repoRoot,
    baseline: null,
    allowNoop: true,
    timeoutMs: 5_000,
    artifactRefs: [],
  });

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.failureCode, "expected-outputs-missing");
    assert.equal(outcome.gates?.find(({ gate }) => gate === "outputs")?.status, "failed");
    assert.match(outcome.reason ?? "", /Expected outputs are missing/);
  }
});

test("verified activity executes with compact predecessor context before returning completion evidence", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "myforge-verified-activity-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "src"));
  const artifactStore = new ArtifactStore({ artifactsPath: join(repoRoot, "docs", "artifacts") });
  artifactStore.write({
    type: "implementation.result",
    category: "work",
    taskId: "PARENT",
    producedBy: "agent",
    status: "complete",
    summary: "The parent task established the required interface.",
    inputs: [],
    filesChanged: ["src/interface.ts"],
    payload: { agentOutputExcerpt: "This full prior conversation must not be forwarded." },
    nextActions: [],
  });
  const task = fixtureTask();
  task.dependencies.push("PARENT");
  task.inputs = ["implementation.result"];
  const agent: AgentDescriptor = {
    name: "test-agent",
    description: "Test agent",
    path: "agents/test-agent.md",
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: "",
  };
  let invoked = false;
  const harness: HarnessAdapter = {
    name: "stub",
    supportsConcurrency: true,
    capabilities: ["repository-tools"],
    async invoke(request) {
      invoked = true;
      assert.match(request.contextBlock, /The parent task established the required interface\./);
      assert.doesNotMatch(request.contextBlock, /This full prior conversation/);
      writeFileSync(join(repoRoot, "src", "output.ts"), "export const output = true;\n");
      return successfulResult();
    },
  };
  const outcome = await executeVerifiedTaskActivity({
    runId: "run-verified",
    taskId: task.id,
    manifestDigest: DIGEST,
    logicalAttempt: 1,
    operationId: "44444444-4444-4444-8444-444444444444",
    request: {
      agent,
      task,
      repoRoot,
      runId: "run-verified",
      attempt: 1,
      timeoutMs: 5_000,
    },
    harness,
    artifactStore,
    predecessorTaskIds: ["PARENT"],
    allowNoop: false,
  });

  assert.equal(invoked, true);
  assert.equal(outcome.status, "complete");
  if (outcome.status === "complete") {
    assert.equal(outcome.evidence.outputFiles.includes("src/output.ts"), true);
  }
});

test("verified activity publishes a declared work artifact into completion evidence", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "myforge-verified-artifact-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "src"));
  const artifactStore = new ArtifactStore({ artifactsPath: join(repoRoot, "docs", "artifacts") });
  const task = fixtureTask();
  task.produces = "work.task-1";
  const agent: AgentDescriptor = {
    name: "test-agent",
    description: "Test agent",
    path: "agents/test-agent.md",
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: "",
  };
  const harness: HarnessAdapter = {
    name: "stub",
    supportsConcurrency: true,
    capabilities: ["repository-tools"],
    async invoke() {
      writeFileSync(join(repoRoot, "src", "output.ts"), "export const output = true;\n");
      return successfulResult();
    },
  };
  const ref: ArtifactRefV1 = {
    schemaVersion: 1,
    artifactId: "art_published",
    uri: `artifact://sha256/${"d".repeat(64)}`,
    mediaType: "application/json",
    sizeBytes: 10,
    sha256: `sha256:${"d".repeat(64)}`,
    retentionClass: "checkpoint-evidence",
  };
  let publishedAdmission: unknown;
  const outcome = await executeVerifiedTaskActivity({
    runId: "run-artifact",
    taskId: task.id,
    manifestDigest: DIGEST,
    logicalAttempt: 1,
    operationId: "55555555-5555-4555-8555-555555555555",
    request: {
      agent,
      task,
      repoRoot,
      runId: "run-artifact",
      attempt: 1,
      timeoutMs: 5_000,
    },
    harness,
    artifactStore,
    predecessorTaskIds: [],
    allowNoop: false,
    publishArtifacts: async (admission) => {
      publishedAdmission = admission;
      return [ref];
    },
  });

  assert.ok(publishedAdmission);
  assert.equal(outcome.status, "complete");
  if (outcome.status === "complete") {
    assert.deepEqual(outcome.evidence.artifactRefs, [ref]);
  }
});

test("verified activity rejects a declared artifact output without a publisher", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "myforge-missing-artifact-publisher-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "src"));
  const artifactStore = new ArtifactStore({ artifactsPath: join(repoRoot, "docs", "artifacts") });
  const task = fixtureTask();
  task.produces = "work.task-1";
  const agent: AgentDescriptor = {
    name: "test-agent",
    description: "Test agent",
    path: "agents/test-agent.md",
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: "",
  };
  const harness: HarnessAdapter = {
    name: "stub",
    supportsConcurrency: true,
    capabilities: ["repository-tools"],
    async invoke() {
      throw new Error("The harness must not run when no artifact publisher is bound.");
    },
  };

  await assert.rejects(
    executeVerifiedTaskActivity({
      runId: "run-missing-publisher",
      taskId: task.id,
      manifestDigest: DIGEST,
      logicalAttempt: 1,
      operationId: "66666666-6666-4666-8666-666666666666",
      request: {
        agent,
        task,
        repoRoot,
        runId: "run-missing-publisher",
        attempt: 1,
        timeoutMs: 5_000,
      },
      harness,
      artifactStore,
      predecessorTaskIds: [],
      allowNoop: false,
    }),
    /has no durable artifact publisher/,
  );
});
