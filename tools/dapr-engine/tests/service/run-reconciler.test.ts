import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunLifecycleEventInputV1 } from "../../contract/v1/index.ts";
import { ORCHESTRATION_FAILED_EVENT_KEY, reconcileFailedRuns, type OrchestrationFailureV1 } from "../../service/run-reconciler.ts";

test("failed and terminated orchestrations mark their runs failed; running ones are left alone", async () => {
  const failures: Record<string, OrchestrationFailureV1 | undefined> = {
    failed: { runtimeStatus: "FAILED", message: `Activity failed: ${"x".repeat(900)}` },
    terminated: { runtimeStatus: "TERMINATED" },
    running: undefined,
  };
  const appended: RunLifecycleEventInputV1[] = [];
  const errors: string[] = [];
  const reconciled = await reconcileFailedRuns({
    listActiveRunIds: async () => ["failed", "terminated", "running", "broken"],
    orchestrationFailure: async (runId) => {
      if (runId === "broken") throw new Error("sidecar unavailable");
      return failures[runId];
    },
    appendEvent: async (input) => { appended.push(input); return input; },
  }, (runId) => errors.push(runId));

  assert.equal(reconciled, 2);
  assert.deepEqual(errors, ["broken"]);
  assert.deepEqual(appended.map((event) => [event.runId, event.eventKey, event.eventType, event.runStatus]), [
    ["failed", ORCHESTRATION_FAILED_EVENT_KEY, "run.failed", "failed"],
    ["terminated", ORCHESTRATION_FAILED_EVENT_KEY, "run.failed", "failed"],
  ]);
  assert.equal((appended[0]?.detail?.message as string).length, 500);
  assert.equal(appended[1]?.detail?.runtimeStatus, "TERMINATED");
  assert.equal(appended[1]?.detail && "message" in appended[1].detail, false);
});

test("a failed append is reported and does not stop the sweep", async () => {
  const errors: string[] = [];
  let calls = 0;
  const reconciled = await reconcileFailedRuns({
    listActiveRunIds: async () => ["a", "b"],
    orchestrationFailure: async () => ({ runtimeStatus: "FAILED" }),
    appendEvent: async () => {
      calls += 1;
      if (calls === 1) throw new Error("database unavailable");
      return undefined;
    },
  }, (runId) => errors.push(runId));
  assert.equal(reconciled, 1);
  assert.deepEqual(errors, ["a"]);
});
