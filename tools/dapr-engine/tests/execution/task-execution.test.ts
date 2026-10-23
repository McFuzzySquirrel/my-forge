import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executionPrompt } from "../../execution/task-execution.ts";
import type { TaskAttemptRequest } from "../../execution/types.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

test("execution prompt states the required forge-result report contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-task-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = manifestTask({ id: "T1", ownerAgent: "builder", expectedOutputs: ["result.txt"] });
  const request: TaskAttemptRequest = {
    agent: agent("builder"),
    task,
    repoRoot: root,
    contextBlock: "",
    requiredCapabilities: ["repository-tools"],
    attempt: { number: 1, maxRetries: 0, runId: `run_${"a".repeat(32)}` },
    budget: { timeoutMs: 1_000 },
    instructions: "Create result.txt.",
  };

  const prompt = executionPrompt(request);
  const content = await readFile(join(root, "docs", "artifacts", "T1.md"), "utf8");

  assert.match(content, /## Required Result Report/);
  assert.match(content, /```forge-result/);
  assert.match(content, /"summary"/);
  assert.match(content, /"unresolved"/);
  assert.match(content, /16,000 characters/);
  assert.match(prompt, /forge-result/);
});
