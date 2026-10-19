import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalDigest,
  sha256Digest,
  type ApprovalBindingV1,
  type ApprovalContextV1,
  type ControlRecordV1,
  type ControlRequestV1,
  type ControlState,
  type TrustedPrincipalV1,
} from "../../contract/v1/index.ts";
import {
  TaskApprovalCoordinator,
  createResumeTaskActivity,
  resolveApprovalWake,
  type ApprovalControlStore,
  type WorkflowEventPublisher,
} from "../../orchestration/approval-control.ts";
import { createTaskCompletionEvidence } from "../../orchestration/outcome.ts";
import {
  createApplyRunControlActivity,
  RunControlCoordinator,
  type RunControlEffects,
} from "../../orchestration/run-control.ts";
import {
  RUN_CONTROL_EVENT_NAME,
  TASK_CONTROL_EVENT_NAME,
  runOrchestrationWorkflowId,
  taskAttemptWorkflowId,
} from "../../orchestration/workflow.ts";
import type {
  ControlStoreResult,
  StoredControlRecordV1,
} from "../../storage/postgres/control-records.ts";

const OPERATOR: TrustedPrincipalV1 = { subject: "operator:42", roles: ["operator"] };
const REQUEST: ControlRequestV1 = {
  schemaVersion: 1,
  controlId: "54c6ee71-6bdb-498e-9dd8-1e8ad67c234d",
  runId: "run-1",
  action: "approve-task",
  payload: {
    taskId: "task-1",
    evidenceDigests: [sha256Digest("evidence")],
  },
};
const CONTEXT: ApprovalContextV1 = {
  runId: "run-1",
  manifestDigest: sha256Digest("manifest"),
  taskId: "task-1",
  logicalAttempt: 2,
  taskWorkflowInstanceId: taskAttemptWorkflowId("run-1", "task-1"),
  taskStatus: "waiting-for-approval",
  evidenceDigests: [sha256Digest("evidence")],
};

class MemoryControlStore implements ApprovalControlStore {
  readonly records = new Map<string, StoredControlRecordV1>();

  async request(request: ControlRequestV1, principal?: TrustedPrincipalV1): Promise<ControlStoreResult> {
    const digest = canonicalDigest({
      runId: request.runId,
      action: request.action,
      payload: request.payload,
    });
    const prior = this.records.get(request.controlId);
    if (prior) {
      return prior.requestDigest === digest
        ? { ok: true, record: structuredClone(prior), reused: true }
        : { ok: false, code: "control-conflict" };
    }
    const record: StoredControlRecordV1 = {
      ...request,
      requestDigest: digest,
      state: "requested",
      history: ["requested"],
      recordVersion: 1,
      payload: request.payload,
      ...(principal ? { requestedBy: principal.subject } : {}),
    };
    this.records.set(request.controlId, record);
    return { ok: true, record: structuredClone(record), reused: false };
  }

  async get(controlId: string): Promise<StoredControlRecordV1 | undefined> {
    const record = this.records.get(controlId);
    return record ? structuredClone(record) : undefined;
  }

  async listAccepted(runId: string, limit: number): Promise<readonly StoredControlRecordV1[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId && record.state === "accepted" && record.action !== "approve-task")
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async transition(
    controlId: string,
    expectedRecordVersion: number,
    to: "accepted" | "applied" | "rejected",
    options: {
      readonly reasonCode?: ControlRecordV1["reasonCode"];
      readonly approvalBinding?: ApprovalBindingV1;
    } = {},
  ): Promise<ControlStoreResult> {
    const record = this.records.get(controlId);
    if (!record) return { ok: false, code: "unknown-control" };
    if (record.recordVersion !== expectedRecordVersion) return { ok: false, code: "stale-revision" };
    if (
      (record.state === "requested" && to !== "accepted" && to !== "rejected") ||
      (record.state === "accepted" && to !== "applied" && to !== "rejected") ||
      record.state === "applied" || record.state === "rejected"
    ) return { ok: false, code: "invalid-transition" };

    const next: StoredControlRecordV1 = {
      ...record,
      state: to as ControlState,
      history: [...record.history, to],
      recordVersion: record.recordVersion + 1,
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
      ...(options.approvalBinding ? { approvalBinding: options.approvalBinding } : {}),
    };
    this.records.set(controlId, next);
    return { ok: true, record: structuredClone(next), reused: false };
  }
}

test("approval coordinator durably accepts before publishing a task wake event", async () => {
  const store = new MemoryControlStore();
  const events: Array<{ instanceId: string; eventName: string; payload: unknown }> = [];
  const publisher: WorkflowEventPublisher = {
    async raiseEvent(instanceId, eventName, payload) {
      events.push({ instanceId, eventName, payload });
    },
  };

  const result = await new TaskApprovalCoordinator(store, publisher).approve(REQUEST, OPERATOR, CONTEXT);
  assert.ok(result.ok);
  assert.equal(result.record.state, "accepted");
  assert.deepEqual(result.record.history, ["requested", "accepted"]);
  assert.deepEqual(events, [{
    instanceId: taskAttemptWorkflowId(REQUEST.runId, "task-1"),
    eventName: TASK_CONTROL_EVENT_NAME,
    payload: { controlId: REQUEST.controlId },
  }]);
});

test("failed event delivery leaves approval accepted for idempotent redispatch", async () => {
  const store = new MemoryControlStore();
  let attempts = 0;
  const publisher: WorkflowEventPublisher = {
    async raiseEvent() {
      attempts += 1;
      if (attempts === 1) throw new Error("Dapr event endpoint unavailable");
    },
  };
  const coordinator = new TaskApprovalCoordinator(store, publisher);

  await assert.rejects(coordinator.approve(REQUEST, OPERATOR, CONTEXT), /event endpoint unavailable/);
  assert.equal((await store.get(REQUEST.controlId))?.state, "accepted");
  const retried = await coordinator.approve(REQUEST, OPERATOR, CONTEXT);
  assert.ok(retried.ok);
  assert.equal(retried.record.state, "accepted");
  assert.equal(attempts, 2);
});

test("unauthorized or stale approval requests are durably rejected without event delivery", async () => {
  const store = new MemoryControlStore();
  let dispatched = false;
  const publisher: WorkflowEventPublisher = {
    async raiseEvent() {
      dispatched = true;
    },
  };
  const coordinator = new TaskApprovalCoordinator(store, publisher);

  const unauthorized = await coordinator.approve(REQUEST, undefined, CONTEXT);
  assert.ok(unauthorized.ok);
  assert.equal(unauthorized.record.reasonCode, "operator-identity-required");
  assert.equal(unauthorized.record.state, "rejected");
  assert.equal(dispatched, false);

  const staleRequest = { ...REQUEST, controlId: "fcfb4e57-65cf-4bc4-aad8-eef760bb4a11" };
  const stale = await coordinator.approve(staleRequest, OPERATOR, {
    ...CONTEXT,
    evidenceDigests: [sha256Digest("previous")],
  });
  assert.ok(stale.ok);
  assert.equal(stale.record.reasonCode, "stale-evidence");
  assert.equal(stale.record.state, "rejected");
  assert.equal(dispatched, false);
});

test("task wake validation requires the accepted control and exact current attempt evidence", async () => {
  const store = new MemoryControlStore();
  const publisher: WorkflowEventPublisher = { async raiseEvent() {} };
  const accepted = await new TaskApprovalCoordinator(store, publisher).approve(REQUEST, OPERATOR, CONTEXT);
  assert.ok(accepted.ok);
  const wake = {
    runId: REQUEST.runId,
    taskId: "task-1",
    manifestDigest: CONTEXT.manifestDigest,
    logicalAttempt: 2,
    taskWorkflowInstanceId: CONTEXT.taskWorkflowInstanceId,
    controlId: REQUEST.controlId,
  };

  assert.deepEqual(await resolveApprovalWake(wake, store, async () => CONTEXT), {
    ok: true,
    binding: accepted.record.approvalBinding,
  });
  assert.deepEqual(await resolveApprovalWake({ ...wake, logicalAttempt: 1 }, store, async () => CONTEXT), {
    ok: false,
    code: "stale-evidence",
  });
  assert.deepEqual(await resolveApprovalWake({ ...wake, controlId: "fcfb4e57-65cf-4bc4-aad8-eef760bb4a11" }, store, async () => CONTEXT), {
    ok: false,
    code: "unknown-control",
  });
});

test("resumeTask validates the persisted approval before resuming and then applies it", async () => {
  const store = new MemoryControlStore();
  const events: WorkflowEventPublisher = { async raiseEvent() {} };
  const accepted = await new TaskApprovalCoordinator(store, events).approve(REQUEST, OPERATOR, CONTEXT);
  assert.ok(accepted.ok);
  const input = {
    runId: REQUEST.runId,
    taskId: CONTEXT.taskId,
    manifestDigest: CONTEXT.manifestDigest,
    logicalAttempt: CONTEXT.logicalAttempt,
    operationId: "97f45fa7-59dd-49e2-b637-08a839d3efb2",
    allowNoop: false,
    waitId: "approval-1",
    controlId: REQUEST.controlId,
    taskWorkflowInstanceId: CONTEXT.taskWorkflowInstanceId,
  };
  let resumeCalls = 0;
  const activity = createResumeTaskActivity({
    store,
    currentContext: async () => CONTEXT,
    async resume(resumeInput, binding) {
      resumeCalls += 1;
      assert.equal(resumeInput.operationId, input.operationId);
      assert.deepEqual(binding, accepted.record.approvalBinding);
      return {
        status: "complete",
        evidence: createTaskCompletionEvidence({
          runId: resumeInput.runId,
          taskId: resumeInput.taskId,
          manifestDigest: resumeInput.manifestDigest,
          logicalAttempt: resumeInput.logicalAttempt,
          operationId: resumeInput.operationId,
          outputFiles: [],
          handoffDigest: sha256Digest("handoff"),
          artifactRefs: [],
          validationCommands: [],
        }),
      };
    },
  });

  const outcome = await activity(undefined, input);
  assert.equal(outcome.status, "complete");
  assert.equal(resumeCalls, 1);
  assert.equal((await store.get(REQUEST.controlId))?.state, "applied");
});

test("resumeTask durably rejects stale approval evidence without calling the resume handler", async () => {
  const store = new MemoryControlStore();
  const accepted = await new TaskApprovalCoordinator(store, { async raiseEvent() {} })
    .approve(REQUEST, OPERATOR, CONTEXT);
  assert.ok(accepted.ok);
  const activity = createResumeTaskActivity({
    store,
    currentContext: async () => ({ ...CONTEXT, evidenceDigests: [sha256Digest("new evidence")] }),
    async resume() {
      assert.fail("stale approval must not resume task");
    },
  });

  const outcome = await activity(undefined, {
    runId: REQUEST.runId,
    taskId: CONTEXT.taskId,
    manifestDigest: CONTEXT.manifestDigest,
    logicalAttempt: CONTEXT.logicalAttempt,
    operationId: "resume-operation",
    allowNoop: false,
    waitId: "approval-1",
    controlId: REQUEST.controlId,
    taskWorkflowInstanceId: CONTEXT.taskWorkflowInstanceId,
  });
  assert.deepEqual(outcome, {
    status: "failed",
    retryable: false,
    failureCode: "approval-rejected",
    reason: "stale-evidence",
  });
  assert.equal((await store.get(REQUEST.controlId))?.state, "rejected");
});

test("run controls are validated, durably accepted, and dispatched by ID", async () => {
  const store = new MemoryControlStore();
  const raised: Array<{ workflowId: string; event: string; payload: unknown }> = [];
  const events: WorkflowEventPublisher = {
    async raiseEvent(workflowId, event, payload) {
      raised.push({ workflowId, event, payload });
    },
  };
  const coordinator = new RunControlCoordinator(
    store,
    {
      async getRunControlContext(runId) {
        return { runId, status: "running", taskStatuses: { "task-1": "running" } };
      },
    },
    events,
  );
  const request: ControlRequestV1 = {
    schemaVersion: 1,
    controlId: "d2303cbf-f2dd-4d5e-93d0-65c93af32778",
    runId: "run-1",
    action: "pause",
    payload: {},
  };

  const result = await coordinator.request(request);
  assert.ok(result.ok);
  assert.equal(result.record.state, "accepted");
  assert.deepEqual(raised, [{
    workflowId: runOrchestrationWorkflowId(request.runId),
    event: RUN_CONTROL_EVENT_NAME,
    payload: { controlId: request.controlId },
  }]);
  await coordinator.dispatchAccepted(request.controlId);
  assert.equal(raised.length, 2, "accepted controls can be redispatched after event-delivery failure");

  const immutable = await coordinator.request({
    ...request,
    controlId: "c217b04d-66b2-4c14-b839-7c8e44fc3842",
    action: "select-tasks",
  });
  assert.ok(immutable.ok);
  assert.equal(immutable.record.state, "rejected");
  assert.equal(immutable.record.reasonCode, "selection-immutable");
});

test("run control application waits for cleanup and stays accepted after effect failure", async () => {
  const store = new MemoryControlStore();
  const request: ControlRequestV1 = {
    schemaVersion: 1,
    controlId: "c217b04d-66b2-4c14-b839-7c8e44fc3842",
    runId: "run-1",
    action: "cancel",
    payload: {},
  };
  const requested = await store.request(request);
  assert.ok(requested.ok);
  const accepted = await store.transition(request.controlId, requested.record.recordVersion, "accepted");
  assert.ok(accepted.ok);
  let cleanupObserved = false;
  const effects: RunControlEffects = {
    async pauseOrStop() {},
    async resume() {},
    async cancel() {
      if (!cleanupObserved) throw new Error("process cleanup is still pending");
    },
    async replayTask() {
      return 2;
    },
  };
  const apply = createApplyRunControlActivity(store, effects);

  await assert.rejects(apply(undefined, { controlId: request.controlId }), /cleanup is still pending/);
  assert.equal((await store.get(request.controlId))?.state, "accepted");
  cleanupObserved = true;
  const applied = await apply(undefined, { controlId: request.controlId });
  assert.equal(applied.state, "applied");
  assert.deepEqual((await store.get(request.controlId))?.history, ["requested", "accepted", "applied"]);
});

test("replay control persists application and reuses the adapter's logical attempt", async () => {
  const store = new MemoryControlStore();
  const request: ControlRequestV1 = {
    schemaVersion: 1,
    controlId: "2c7aaf46-5e54-49dc-a399-a5e64c4521ce",
    runId: "run-1",
    action: "replay-task",
    payload: { taskId: "task-1" },
  };
  const coordinator = new RunControlCoordinator(
    store,
    {
      async getRunControlContext(runId) {
        return { runId, status: "failed", taskStatuses: { "task-1": "failed" } };
      },
    },
    { async raiseEvent() {} },
  );
  const accepted = await coordinator.request(request);
  assert.ok(accepted.ok);
  let allocatedAttempt = 0;
  const apply = createApplyRunControlActivity(store, {
    async pauseOrStop() {},
    async resume() {},
    async cancel() {},
    async replayTask() {
      allocatedAttempt ||= 4;
      return allocatedAttempt;
    },
  });

  const first = await apply(undefined, { controlId: request.controlId });
  const retried = await apply(undefined, { controlId: request.controlId });
  assert.equal(first.replayLogicalAttempt, 4);
  assert.equal(retried.replayLogicalAttempt, 4);
  assert.equal((await store.get(request.controlId))?.state, "applied");
});
