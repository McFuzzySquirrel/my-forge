import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunLifecycleEventInputV1, RunLifecycleEventV1 } from "../../contract/v1/index.ts";
import { createRecordRunLifecycleEventActivity } from "../../orchestration/status-activity.ts";

const input: RunLifecycleEventInputV1 = {
  schemaVersion: 1,
  runId: "run-activity",
  eventKey: "run:started",
  eventType: "run.started",
  runStatus: "running",
};

test("status activity returns the durable event and propagates persistence errors", async () => {
  const event: RunLifecycleEventV1 = {
    ...input,
    sequence: 2,
    createdAt: "2026-10-18T00:00:00.000Z",
  };
  const activity = createRecordRunLifecycleEventActivity({
    async appendEvent(received) {
      assert.deepEqual(received, input);
      return { event, reused: false };
    },
  });
  assert.deepEqual(await activity({}, input), event);

  const failed = createRecordRunLifecycleEventActivity({
    async appendEvent() {
      throw new Error("status store unavailable");
    },
  });
  await assert.rejects(failed({}, input), /status store unavailable/);
});
