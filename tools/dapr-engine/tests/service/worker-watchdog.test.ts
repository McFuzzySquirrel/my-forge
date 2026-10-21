import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowRuntime } from "@dapr/dapr";
import { sdkWorkflowWorkerProbe, watchWorkflowWorker } from "../../service/worker-watchdog.ts";

test("the SDK probe observes the pinned Dapr SDK's inner worker state", () => {
  const runtime = new WorkflowRuntime({ daprHost: "127.0.0.1", daprPort: "1" });
  assert.equal(sdkWorkflowWorkerProbe(runtime).running(), false);
  assert.equal(sdkWorkflowWorkerProbe({}).running(), undefined);
});

test("the watchdog reports a stopped worker once", async () => {
  let running: boolean | undefined = true;
  let lost = 0;
  const watchdog = watchWorkflowWorker({
    probe: { running: () => running },
    stopping: () => false,
    onLost: () => { lost++; },
    intervalMs: 5,
  });
  await delay(25);
  assert.equal(lost, 0);
  running = false;
  await delay(40);
  assert.equal(lost, 1);
  watchdog.stop();
});

test("the watchdog ignores an intentional shutdown and an unobservable worker", async () => {
  let stopping = true;
  let running: boolean | undefined = false;
  let lost = 0;
  const watchdog = watchWorkflowWorker({
    probe: { running: () => running },
    stopping: () => stopping,
    onLost: () => { lost++; },
    intervalMs: 5,
  });
  await delay(25);
  stopping = false;
  running = undefined;
  await delay(25);
  assert.equal(lost, 0);
  watchdog.stop();
});
