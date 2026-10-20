import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ControlRequestV1 } from "../../contract/v1/index.ts";
import { TaskApprovalCoordinator } from "../../orchestration/approval-control.ts";
import {
  ExecutionHost,
  executionHostRunFromSubmission,
  type ExecutionHostRunV1,
} from "../../orchestration/execution-host.ts";
import {
  taskAttemptWorkflowIdForAttempt,
  taskOperationId,
  type ExecuteTaskActivityInputV1,
  type TaskActivityOutcomeV1,
} from "../../orchestration/workflow.ts";
import {
  acceptedSubmission,
  agent,
  createExecutionFixture,
  git,
  manifestTask,
  TARGET_REF,
  type ExecutionFixture,
} from "../support/execution-fixture.ts";
import { ScriptedHarness } from "../support/scripted-harness.ts";

const connectionString = process.env.POSTGRES_TEST_URL;

test("execution host executes, verifies, integrates, retries, and resumes approved tasks", {
  skip: !connectionString && "POSTGRES_TEST_URL is not set",
}, async () => {
  const fixture = await createExecutionFixture(connectionString!, { label: "host" });
  try {
    await exercise(fixture);
  } finally {
    await fixture.cleanup();
  }
});

async function exercise(fixture: ExecutionFixture): Promise<void> {
  const submission = acceptedSubmission({
    repositoryId: fixture.repositoryId,
    phases: [{
      id: "phase-1",
      tasks: [
        manifestTask({ id: "T-1", ownerAgent: "alpha", expectedOutputs: ["one.txt"], validationCommands: ["grep -qx one one.txt"] }),
        manifestTask({ id: "T-2", ownerAgent: "alpha", dependencies: ["T-1"], expectedOutputs: ["two.txt"], validationCommands: ["grep -qx one one.txt", "grep -qx two two.txt"] }),
        manifestTask({ id: "T-3", ownerAgent: "beta", expectedOutputs: ["three.txt"], validationCommands: ["grep -qx three three.txt"] }),
        manifestTask({ id: "T-4", ownerAgent: "gamma", expectedOutputs: ["four.txt"], validationCommands: ["grep -qx four four.txt"] }),
        manifestTask({ id: "T-5", ownerAgent: "delta", expectedOutputs: ["five.txt"], validationCommands: ["grep -qx five five.txt"], approvalRequired: true }),
        manifestTask({ id: "T-6", ownerAgent: "epsilon", expectedOutputs: ["six.txt"], validationCommands: ["grep -qx six six.txt"] }),
        {
          ...manifestTask({ id: "T-7", ownerAgent: "unowned", expectedOutputs: [], validationCommands: [] }),
          ownerAgent: undefined,
          contract: {
            version: 1,
            kind: "human-review",
            requirements: ["Review the integrated outputs."],
            acceptanceCriteria: ["The reviewer approves the evidence."],
            constraints: [],
            references: ["README.md"],
            reviewFile: "docs/review.json",
          },
        },
      ],
    }],
    settings: { maxRetries: 1 },
  });
  const runId = `run_${randomUUID().replaceAll("-", "")}`;
  const harness = new ScriptedHarness((request) => {
    const id = request.task.id;
    if (id === "T-3" && request.attempt.number === 1) return { files: { "three.txt": "wrong\n" } };
    const name = ({ "T-1": "one", "T-2": "two", "T-3": "three", "T-4": "four", "T-5": "five", "T-6": "six" } as Record<string, string>)[id]!;
    return { files: { [`${name}.txt`]: `${name}\n` }, delayMs: id === "T-4" ? 50 : 0 };
  });
  const run: ExecutionHostRunV1 = executionHostRunFromSubmission(runId, submission, {
    agentFor: (task) => agent(task.ownerAgent ?? "unowned"),
    harness,
    credentials: async () => ({ GH_TOKEN: "fixture-token-not-a-secret" }),
  });
  await fixture.status.createRun({
    schemaVersion: 1,
    runId,
    repositoryId: fixture.repositoryId,
    targetRef: TARGET_REF,
    manifestDigest: submission.manifestDigest,
    taskIds: [...submission.selection.effectiveTaskIds],
  });
  const audit: Record<string, unknown>[] = [];
  const host = new ExecutionHost({
    runs: (id) => id === runId ? run : undefined,
    receipts: fixture.receipts,
    executions: fixture.executions,
    integration: fixture.integration,
    checkpoints: fixture.checkpoints,
    status: fixture.status,
    controls: fixture.controls,
    repositoryRoot: (id) => id === fixture.repositoryId ? fixture.target : undefined,
    scratchRoot: fixture.scratchRoot,
    workerId: "host-test",
    budgetMs: 60_000,
    heartbeatIntervalMs: 200,
    heartbeatTtlMs: 5_000,
    inheritedEnvironment: { PATH: process.env.PATH, DATABASE_URL: "postgres://must-not-leak", POSTGRES_TEST_URL: "x" },
    audit: (event) => audit.push({ ...event }),
  });
  const input = (taskId: string, logicalAttempt = 1): ExecuteTaskActivityInputV1 => ({
    runId,
    taskId,
    manifestDigest: submission.manifestDigest,
    logicalAttempt,
    operationId: taskOperationId(runId, taskId, logicalAttempt),
    allowNoop: false,
  });
  const head = () => git(fixture.target, ["rev-parse", TARGET_REF]);
  const changed = (commit: string) => git(fixture.target, ["show", "--name-only", "--format=", commit]).split("\n").filter(Boolean);

  // Dependency chain: T-2 starts from the integrated T-1 head.
  const first = await host.executeTask(input("T-1"));
  assert.equal(first.status, "complete", JSON.stringify(first));
  const afterFirst = head();
  assert.notEqual(afterFirst, fixture.base);
  assert.deepEqual(changed(afterFirst), ["one.txt"]);
  const second = await host.executeTask(input("T-2"));
  assert.equal(second.status, "complete", JSON.stringify(second));
  assert.equal(git(fixture.target, ["rev-parse", `${head()}^`]), afterFirst);
  assert.deepEqual(changed(head()), ["two.txt"]);

  // Redelivery of a completed operation returns the journaled outcome without a new effect.
  const before = head();
  assert.deepEqual(await host.executeTask(input("T-1")), first);
  assert.equal(head(), before);

  // Verification failure is retryable; the next attempt sees the failure and succeeds.
  const failed = await host.executeTask(input("T-3", 1));
  assert.equal(failed.status, "failed");
  assert.equal((failed as Extract<TaskActivityOutcomeV1, { status: "failed" }>).retryable, true);
  assert.equal(head(), before);
  const retried = await host.executeTask(input("T-3", 2));
  assert.equal(retried.status, "complete", JSON.stringify(retried));
  assert.match(harness.invocations.find((call) => call.taskId === "T-3" && call.attempt === 2)!.instructions, /grep -qx three/);

  // Parallel tasks from the same base both integrate; the later one is rebased and revalidated.
  const parallelBase = head();
  const [p1, p2] = await Promise.all([host.executeTask(input("T-4")), host.executeTask(input("T-6"))]);
  assert.equal(p1.status, "complete", JSON.stringify(p1));
  assert.equal(p2.status, "complete", JSON.stringify(p2));
  const parallelHead = head();
  assert.equal(git(fixture.target, ["rev-parse", `${parallelHead}^^`]), parallelBase);
  assert.deepEqual(new Set([...changed(parallelHead), ...changed(`${parallelHead}^`)]), new Set(["four.txt", "six.txt"]));
  const parallelWorkspaces = harness.invocations.filter((call) => call.taskId === "T-4" || call.taskId === "T-6");
  assert.notEqual(parallelWorkspaces[0]!.repoRoot, parallelWorkspaces[1]!.repoRoot);

  const waiting = await host.executeTask(input("T-5"));
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting));

  // Approval: T-5 waited after verification with no target change; approve and resume.
  assert.equal(head(), parallelHead);
  const waitId = (waiting as Extract<TaskActivityOutcomeV1, { status: "waiting" }>).waitId;
  const instance = taskAttemptWorkflowIdForAttempt(runId, "T-5", 1);
  for (const [suffix, eventType, status] of [
    ["started", "attempt.started", "running"],
    ["wait:1", "attempt.waiting-for-approval", "waiting-for-approval"],
  ] as const) {
    await fixture.status.appendEvent({
      schemaVersion: 1,
      runId,
      eventKey: `task:T-5:attempt:1:${suffix}`,
      eventType,
      taskId: "T-5",
      logicalAttempt: 1,
      taskStatus: status,
      attemptStatus: status,
      ...(eventType === "attempt.waiting-for-approval" ? { detail: { waitId, taskWorkflowInstanceId: instance } } : {}),
    });
  }
  const context = await host.approvalContext(runId, "T-5");
  assert.ok(context);
  assert.equal(context.taskStatus, "waiting-for-approval");
  assert.equal(context.evidenceDigests.length, 2);
  const raised: { instance: string; payload: unknown }[] = [];
  const coordinator = new TaskApprovalCoordinator(fixture.controls, {
    raiseEvent: async (instanceId, _name, payload) => {
      raised.push({ instance: instanceId, payload });
    },
  });
  const controlId = randomUUID();
  const request: ControlRequestV1 = {
    schemaVersion: 1,
    controlId,
    runId,
    action: "approve-task",
    payload: { taskId: "T-5", evidenceDigests: [...context.evidenceDigests] },
  } as ControlRequestV1;
  const approved = await coordinator.approve(request, { subject: "operator@example.invalid", roles: ["operator"] }, context);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(raised, [{ instance, payload: { controlId } }]);
  await fixture.status.appendEvent({
    schemaVersion: 1,
    runId,
    eventKey: `task:T-5:attempt:1:resumed:${controlId}`,
    eventType: "attempt.resumed",
    taskId: "T-5",
    logicalAttempt: 1,
    taskStatus: "running",
    attemptStatus: "running",
  });
  const resumed = await host.resumeTaskActivity()(undefined, {
    ...input("T-5"),
    waitId,
    controlId,
    operationId: taskOperationId(runId, "T-5", 1, `resume:${waitId}`),
    taskWorkflowInstanceId: instance,
  });
  assert.equal(resumed.status, "complete", JSON.stringify(resumed));
  assert.equal(git(fixture.target, ["rev-parse", `${head()}^`]), parallelHead);
  assert.deepEqual(changed(head()), ["five.txt"]);
  assert.equal((await fixture.controls.get(controlId))?.state, "applied");

  // Human review: no harness runs and no target change; approval completes the task.
  const invocationsBeforeReview = harness.invocations.length;
  const reviewHead = head();
  const reviewWait = await host.executeTask(input("T-7"));
  assert.equal(reviewWait.status, "waiting", JSON.stringify(reviewWait));
  assert.deepEqual(await host.executeTask(input("T-7")), reviewWait);
  const reviewWaitId = (reviewWait as Extract<TaskActivityOutcomeV1, { status: "waiting" }>).waitId;
  const reviewInstance = taskAttemptWorkflowIdForAttempt(runId, "T-7", 1);
  for (const [suffix, eventType, status] of [
    ["started", "attempt.started", "running"],
    ["wait:1", "attempt.waiting-for-approval", "waiting-for-approval"],
  ] as const) {
    await fixture.status.appendEvent({
      schemaVersion: 1,
      runId,
      eventKey: `task:T-7:attempt:1:${suffix}`,
      eventType,
      taskId: "T-7",
      logicalAttempt: 1,
      taskStatus: status,
      attemptStatus: status,
      ...(eventType === "attempt.waiting-for-approval" ? { detail: { waitId: reviewWaitId, taskWorkflowInstanceId: reviewInstance } } : {}),
    });
  }
  const reviewContext = await host.approvalContext(runId, "T-7");
  assert.ok(reviewContext);
  assert.equal(reviewContext.evidenceDigests.length, 1);
  const reviewControlId = randomUUID();
  const reviewApproved = await coordinator.approve({
    schemaVersion: 1,
    controlId: reviewControlId,
    runId,
    action: "approve-task",
    payload: { taskId: "T-7", evidenceDigests: [...reviewContext.evidenceDigests] },
  } as ControlRequestV1, { subject: "reviewer@example.invalid", roles: ["operator"] }, reviewContext);
  assert.equal(reviewApproved.ok, true, JSON.stringify(reviewApproved));
  const reviewed = await host.resumeTaskActivity()(undefined, {
    ...input("T-7"),
    waitId: reviewWaitId,
    controlId: reviewControlId,
    operationId: taskOperationId(runId, "T-7", 1, `resume:${reviewWaitId}`),
    taskWorkflowInstanceId: reviewInstance,
  });
  assert.equal(reviewed.status, "complete", JSON.stringify(reviewed));
  const reviewEvidence = (reviewed as Extract<TaskActivityOutcomeV1, { status: "complete" }>).evidence;
  assert.deepEqual(reviewEvidence.outputFiles, []);
  assert.equal(reviewEvidence.handoffDigest, reviewContext.evidenceDigests[0]);
  assert.match(reviewEvidence.gates.harness.evidence?.[0] ?? "", /human review approved/);
  assert.ok((await fixture.checkpoints.resolveArtifact(reviewEvidence.artifactRefs[0]!)).ok);
  assert.equal(head(), reviewHead);
  assert.equal(harness.invocations.length, invocationsBeforeReview);

  // Every completed outcome carries validation and checkpoint evidence resolvable from the store.
  for (const outcome of [first, second, retried, p1, p2, resumed]) {
    assert.equal(outcome.status, "complete");
    const refs = (outcome as Extract<TaskActivityOutcomeV1, { status: "complete" }>).evidence.artifactRefs;
    assert.equal(refs.length, 2);
    const validation = await fixture.checkpoints.resolveArtifact(refs[0]!);
    assert.equal(validation.ok, true);
  }

  // The harness child saw an isolated home and only allowlisted variables.
  for (const call of harness.invocations) {
    assert.ok(call.childHome?.startsWith(fixture.scratchRoot), call.childHome);
    assert.ok(!call.childEnvironment.includes("DATABASE_URL"));
    assert.ok(!call.childEnvironment.includes("POSTGRES_TEST_URL"));
    assert.ok(call.childEnvironment.includes("GH_TOKEN"));
    assert.ok(!call.repoRoot.startsWith(fixture.target));
  }
  assert.ok(!JSON.stringify(audit).includes("fixture-token-not-a-secret"));
}
