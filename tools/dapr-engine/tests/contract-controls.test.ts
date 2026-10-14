import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeTaskApproval,
  sha256Digest,
  type ControlRequestV1,
} from "../contract/v1/index.ts";

const request: ControlRequestV1 = {
  schemaVersion: 1,
  controlId: "54c6ee71-6bdb-498e-9dd8-1e8ad67c234d",
  runId: "run-1",
  action: "approve-task",
  payload: {
    taskId: "task-1",
    evidenceDigests: [sha256Digest("evidence-a"), sha256Digest("evidence-b")],
    yes: true,
  },
};

const context = {
  runId: "run-1",
  manifestDigest: sha256Digest("manifest"),
  taskId: "task-1",
  logicalAttempt: 2,
  taskWorkflowInstanceId: "forge-task-attempt-2",
  taskStatus: "waiting-for-approval",
  evidenceDigests: [sha256Digest("evidence-b"), sha256Digest("evidence-a")],
} as const;

test("approval requires trusted operator identity and ignores confirmation flags", () => {
  assert.deepEqual(authorizeTaskApproval(request, undefined, context), {
    ok: false,
    code: "operator-identity-required",
  });
  assert.deepEqual(authorizeTaskApproval(request, { subject: "client", roles: ["client"] }, context), {
    ok: false,
    code: "operator-identity-required",
  });
});

test("approval binds the authenticated operator to the current run, attempt, and evidence", () => {
  assert.deepEqual(
    authorizeTaskApproval(request, { subject: "operator:42", roles: ["operator"] }, context),
    {
      ok: true,
      binding: {
        runId: "run-1",
        manifestDigest: context.manifestDigest,
        taskId: "task-1",
        logicalAttempt: 2,
        taskWorkflowInstanceId: context.taskWorkflowInstanceId,
        evidenceDigests: context.evidenceDigests,
        operatorId: "operator:42",
      },
    },
  );
  assert.deepEqual(authorizeTaskApproval(request, { subject: "operator:42", roles: ["operator"] }, {
    ...context,
    evidenceDigests: [sha256Digest("old-evidence")],
  }), { ok: false, code: "stale-evidence" });
  assert.deepEqual(authorizeTaskApproval(request, { subject: "operator:42", roles: ["operator"] }, {
    ...context,
    taskStatus: "running",
  }), { ok: false, code: "invalid-task-state" });
});
