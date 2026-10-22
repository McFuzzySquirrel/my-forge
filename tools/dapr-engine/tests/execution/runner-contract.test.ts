import assert from "node:assert/strict";
import { sha256Digest } from "../../contract/v1/index.ts";
import test from "node:test";
import type {
  HarnessRunnerIdentityV1,
  HarnessRunnerRequestV1,
  HarnessRunnerResultV1,
} from "../../execution/runner-contract.ts";
import { parseHarnessRunnerResult } from "../../execution/runner-contract.ts";
import { InMemoryHarnessRunner } from "../support/in-memory-harness-runner.ts";

const identity: HarnessRunnerIdentityV1 = {
  runId: "run-1",
  taskId: "TASK-1",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  logicalAttempt: 1,
  operationId: "11111111-1111-4111-8111-111111111111",
};

const request: HarnessRunnerRequestV1 = {
  schemaVersion: 1,
  identity,
  repositoryId: "repo-1",
  baseRevision: "a".repeat(40),
  harness: "opencode",
  agent: {
    name: "test-agent",
    description: "A test agent",
    path: "agents/test-agent.md",
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: "Test instructions",
  },
  task: {
    id: "TASK-1",
    title: "Run task",
    description: "Execute a task.",
    dependencies: [],
    expectedOutputs: ["src/output.ts"],
    validationCommands: [],
    approvalRequired: false,
    sourceLines: [],
  },
  contextBlock: "Context",
  requiredCapabilities: ["repository-tools"],
  timeoutMs: 5_000,
  instructions: "Implement the task.",
};

function successfulResult(): HarnessRunnerResultV1 {
  const diff = Buffer.from("diff");
  return {
    schemaVersion: 1,
    identity,
    result: {
      success: true,
      outputFiles: ["src/output.ts"],
      stdout: "done",
      stderr: "",
      durationMs: 1,
    },
    workspaceDelta: {
      format: "git-binary-diff-v1",
      baseRevision: request.baseRevision,
      digest: sha256Digest(diff),
      contentBase64: diff.toString("base64"),
    },
  };
}

test("runner contract serializes a typed request without host paths or credentials", () => {
  const serialized = JSON.stringify(request);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(parsed, request);
  assert.equal("repoRoot" in parsed, false);
  assert.equal("environment" in parsed, false);
  assert.equal("capability" in parsed, false);
  assert.equal("credentials" in parsed, false);
});

test("runner result validation fences the attempt and verifies the bounded diff", () => {
  const result = parseHarnessRunnerResult(request, successfulResult(), 16);

  assert.equal(result.identity.operationId, request.identity.operationId);
  assert.equal(result.workspaceDelta.baseRevision, request.baseRevision);
  assert.equal(Buffer.from(result.workspaceDelta.contentBase64, "base64").toString(), "diff");
});

test("runner result validation rejects stale identity, base revision, digest, and oversized diffs", () => {
  const valid = successfulResult();
  assert.throws(() => parseHarnessRunnerResult(request, {
    ...valid,
    identity: { ...valid.identity, taskId: "TASK-2" },
  }, 16), /does not match the requested attempt/);
  assert.throws(() => parseHarnessRunnerResult(request, {
    ...valid,
    workspaceDelta: { ...valid.workspaceDelta, baseRevision: "f".repeat(40) },
  }, 16), /invalid workspace delta/);
  assert.throws(() => parseHarnessRunnerResult(request, {
    ...valid,
    workspaceDelta: { ...valid.workspaceDelta, digest: `sha256:${"f".repeat(64)}` },
  }, 16), /digest does not match/);
  const oversizedBytes = Buffer.alloc(12);
  assert.throws(() => parseHarnessRunnerResult(request, {
    ...valid,
    workspaceDelta: {
      ...valid.workspaceDelta,
      digest: sha256Digest(oversizedBytes),
      contentBase64: oversizedBytes.toString("base64"),
    },
  }, 3), /exceeds 3 bytes/);

  assert.throws(() => parseHarnessRunnerResult(request, valid, 3), /exceeds 3 bytes/);
});

test("in-memory runner receives an isolated request and returns a cloned result", async () => {
  const expected = successfulResult();
  const runner = new InMemoryHarnessRunner(async (received) => {
    assert.deepEqual(received, request);
    return expected;
  });

  const result = await runner.run(request);

  assert.equal(runner.requests.length, 1);
  assert.notEqual(runner.requests[0], request);
  assert.deepEqual(result, expected);
  assert.notEqual(result, expected);
});

test("in-memory runner forwards cancellation and rejects an already-aborted request", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  const runner = new InMemoryHarnessRunner(async () => successfulResult());

  await assert.rejects(runner.run(request, controller.signal), (error) => error === reason);
  assert.equal(runner.requests.length, 0);
});
