import assert from "node:assert/strict";
import test from "node:test";
import { activityPresentation } from "./console/dashboard/activity.ts";

test("activity says logging was off whenever the run did not enable it", () => {
  assert.deepEqual(activityPresentation({ hostExecution: true, logHarnessActivity: true }), { kind: "host-log" });
  assert.deepEqual(activityPresentation({ hostExecution: true, logHarnessActivity: false }), { kind: "disabled" });
  assert.deepEqual(activityPresentation({ hostExecution: true }), { kind: "disabled" });
  assert.deepEqual(activityPresentation({ hostExecution: false }), { kind: "disabled" });
});

test("worker activity reads the service API only when the run enabled logging", () => {
  assert.deepEqual(activityPresentation({ hostExecution: false, logHarnessActivity: true }), { kind: "service" });
  assert.deepEqual(activityPresentation({ logHarnessActivity: true }), { kind: "service" });
});
