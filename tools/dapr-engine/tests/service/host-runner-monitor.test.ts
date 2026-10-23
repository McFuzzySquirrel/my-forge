import assert from "node:assert/strict";
import test from "node:test";
import { HostRunnerMonitor } from "../../service/host-runner-monitor.ts";

test("host-runner monitoring validates repository filters and returns only safe summary fields", async () => {
  let calls = 0;
  const monitor = new HostRunnerMonitor({
    async listSummaries(repositoryId) {
      calls += 1;
      assert.equal(repositoryId, "repo_a");
      return {
        activeTruncated: true,
        jobs: [{
          operationId: "95c28f53-4658-4eb9-9bd8-e96c88cb23c2",
          runId: `run_${"a".repeat(32)}`,
          taskId: "T1",
          repositoryId: "repo_a",
          harness: "stub",
          state: "failed",
          createdAt: "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:01:00.000Z",
          errorMessage: "provider-secret",
          request: { instructions: "private task context" },
          result: { stdout: "private harness output" },
        }],
      };
    },
  });

  const invalid = await monitor.list("../repo");
  assert.equal(invalid.ok ? 0 : invalid.status, 400);
  assert.equal(calls, 0);

  const result = await monitor.list("repo_a");
  assert.ok(result.ok);
  assert.deepEqual(result.body, {
    activeTruncated: true,
    jobs: [{
      operationId: "95c28f53-4658-4eb9-9bd8-e96c88cb23c2",
      runId: `run_${"a".repeat(32)}`,
      taskId: "T1",
      repositoryId: "repo_a",
      harness: "stub",
      state: "failed",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:01:00.000Z",
    }],
  });
  assert.doesNotMatch(JSON.stringify(result.body), /provider-secret|private task context|private harness output/);
});
