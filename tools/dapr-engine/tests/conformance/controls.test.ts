// Contract v1 §2 conformance: control acknowledgement, boundaries, and approvals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import { ReferenceExecutionService } from "./support/reference-model.ts";
import { OPERATOR, control, submission } from "./support/fixtures.ts";

function startedRun(service = new ReferenceExecutionService()) {
  const accepted = service.submit(submission());
  assert.ok(accepted.ok);
  return { service, runId: accepted.runId };
}

test("C05: a duplicate controlId with an identical payload returns the original control record", () => {
  const { service, runId } = startedRun();
  const request = control(runId, "pause");
  const first = service.control(request);
  const revision = service.status(runId)?.revision;
  const retried = service.control({ ...request });

  assert.ok(first.ok && retried.ok);
  assert.deepEqual(retried.record, first.record);
  assert.equal(service.status(runId)?.revision, revision, "a retried control has no second effect");
});

test("C06: reusing a controlId with a different payload is a conflict", () => {
  const { service, runId } = startedRun();
  const request = control(runId, "replay-task", { taskId: "T1" });
  service.control(request);
  const conflicting = service.control({ ...request, payload: { taskId: "T2" } });
  assert.deepEqual(conflicting, { ok: false, code: "control-conflict" });
  const differentAction = service.control({ ...request, action: "cancel", payload: {} });
  assert.deepEqual(differentAction, { ok: false, code: "control-conflict" });
});

for (const action of ["pause", "stop"] as const) {
  test(`C07: ${action} accepted while an activity runs is not process exit and blocks the next dispatch`, () => {
    const { service, runId } = startedRun();
    const dispatched = service.dispatchNext(runId);
    assert.equal(dispatched?.taskId, "T1");

    const result = service.control(control(runId, action));
    assert.ok(result.ok);
    assert.equal(result.record.state, "accepted");
    assert.deepEqual(result.record.history, ["requested", "accepted"]);
    assert.equal(service.status(runId)?.status, action === "pause" ? "pausing" : "stopping");
    assert.equal(service.status(runId)?.processRunning, true, "acknowledgement does not claim the harness stopped");
    assert.equal(service.dispatchNext(runId), null, "no dispatch before the task boundary");

    assert.deepEqual(service.completeActivity(runId, { ...dispatched!, outcome: "complete" }), { ok: true });
    assert.equal(service.status(runId)?.status, "paused", `${action} remains resumable, not terminal`);
    assert.equal(service.controlRecord(result.record.controlId)?.state, "applied");
    assert.equal(service.dispatchNext(runId), null);

    const resumed = service.control(control(runId, "resume"));
    assert.ok(resumed.ok && resumed.record.state === "applied");
    assert.equal(service.dispatchNext(runId)?.taskId, "T2");
  });
}

test("C08: cancel racing a late activity result preserves diagnostics and rejects late acceptance", () => {
  const { service, runId } = startedRun();
  const dispatched = service.dispatchNext(runId)!;
  const cancel = service.control(control(runId, "cancel"));
  assert.ok(cancel.ok);
  assert.equal(cancel.record.state, "accepted");
  assert.equal(service.status(runId)?.status, "cancelling");

  const late = service.completeActivity(runId, { ...dispatched, outcome: "complete", diagnostic: "harness exited 0 after cancel" });
  assert.deepEqual(late, { ok: false, code: "late-result" });
  const during = service.status(runId)!;
  assert.notEqual(during.tasks.T1.status, "complete");
  assert.equal(during.status, "cancelling", "cleanup is not complete until process exit is observed");
  assert.equal(service.controlRecord(cancel.record.controlId)?.state, "accepted");

  service.observeProcessExit(runId, dispatched.operationId);
  const after = service.status(runId)!;
  assert.equal(after.status, "cancelled");
  assert.equal(after.processRunning, false);
  assert.equal(after.tasks.T1.status, "cancelled");
  assert.equal(after.tasks.T1.attempts[0].outcome, "rejected-late");
  assert.deepEqual(after.diagnostics, ["harness exited 0 after cancel"]);
  assert.equal(service.controlRecord(cancel.record.controlId)?.state, "applied");
  assert.equal(service.dispatchNext(runId), null);
});

test("C09: task replay allocates a larger logical attempt and retains prior attempt and operation records", () => {
  const { service, runId } = startedRun();
  const first = service.dispatchNext(runId)!;
  service.completeActivity(runId, { ...first, outcome: "complete" });

  const replay = service.control(control(runId, "replay-task", { taskId: "T1" }));
  assert.ok(replay.ok && replay.record.state === "applied");
  const second = service.dispatchNext(runId)!;
  assert.equal(second.taskId, "T1");
  assert.equal(second.logicalAttempt, first.logicalAttempt + 1);
  assert.notEqual(second.operationId, first.operationId);

  const attempts = service.status(runId)!.tasks.T1.attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.logicalAttempt), [1, 2]);
  assert.equal(attempts[0].outcome, "complete");
  assert.equal(attempts[0].operationId, first.operationId);
});

function awaitingApproval() {
  const { service, runId } = startedRun();
  const evidence = [sha256Digest("review evidence v1")];
  const dispatched = service.dispatchNext(runId)!;
  service.completeActivity(runId, { ...dispatched, outcome: "waiting-for-approval", evidenceDigests: evidence });
  assert.equal(service.status(runId)?.tasks.T1.status, "waiting-for-approval");
  return { service, runId, evidence };
}

test("C17: approval without an authenticated operator identity is rejected; confirmation flags are not identity", () => {
  const { service, runId, evidence } = awaitingApproval();
  const payload = { taskId: "T1", evidenceDigests: evidence, yes: true, confirmHumanReview: true };
  for (const principal of [undefined, { operatorId: "launcher", role: "client" as const }]) {
    const result = service.control(control(runId, "approve-task", payload), principal);
    assert.ok(result.ok);
    assert.equal(result.record.reasonCode, "operator-identity-required");
  }
  assert.equal(service.status(runId)?.tasks.T1.status, "waiting-for-approval");
  assert.equal(service.approval(runId, "T1"), undefined);
});

test("C18: approval with stale evidence is rejected; accepted approval binds snapshot, task, and evidence", () => {
  const { service, runId, evidence } = awaitingApproval();
  const stale = service.control(control(runId, "approve-task", { taskId: "T1", evidenceDigests: [sha256Digest("old")] }), OPERATOR);
  assert.ok(stale.ok);
  assert.equal(stale.record.reasonCode, "stale-evidence");

  const approved = service.control(control(runId, "approve-task", { taskId: "T1", evidenceDigests: evidence }), OPERATOR);
  assert.ok(approved.ok && approved.record.state === "applied");
  assert.deepEqual(service.approval(runId, "T1"), {
    runId,
    manifestDigest: service.status(runId)!.manifestDigest,
    taskId: "T1",
    evidenceDigests: evidence,
    operatorId: OPERATOR.operatorId,
  });
});

test("status revisions increase monotonically across accepted changes", () => {
  const { service, runId } = startedRun();
  const revisions = [service.status(runId)!.revision];
  const dispatched = service.dispatchNext(runId)!;
  revisions.push(service.status(runId)!.revision);
  service.completeActivity(runId, { ...dispatched, outcome: "complete" });
  revisions.push(service.status(runId)!.revision);
  assert.deepEqual([...revisions].sort((a, b) => a - b), revisions);
  assert.equal(new Set(revisions).size, revisions.length);
});
