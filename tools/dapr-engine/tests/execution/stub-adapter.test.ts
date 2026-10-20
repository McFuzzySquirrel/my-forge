import assert from "node:assert/strict";
import test from "node:test";
import { StubAdapter } from "../../execution/harness/stub-adapter.ts";
import { readTaskHandoff } from "../../execution/task-result.ts";
import type { TaskAttemptRequest } from "../../execution/types.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

function request(task: TaskAttemptRequest["task"]): TaskAttemptRequest {
  return { agent: agent("builder"), task, repoRoot: process.cwd(), runId: "run", attempt: 1, maxRetries: 0, timeoutMs: 1_000 } as unknown as TaskAttemptRequest;
}

test("stub completions carry a valid handoff for contract tasks only", async () => {
  const contract = await new StubAdapter().invoke(request(manifestTask({ id: "T1", ownerAgent: "builder" })));
  assert.equal(contract.success, true);
  assert.deepEqual(readTaskHandoff(contract.stdout).handoff?.unresolved, []);

  const { contract: _omitted, ...legacy } = manifestTask({ id: "T2", ownerAgent: "builder" });
  const plain = await new StubAdapter().invoke(request(legacy as TaskAttemptRequest["task"]));
  assert.equal(plain.stdout, "[stub] builder completed task T2: Task T2");
});
