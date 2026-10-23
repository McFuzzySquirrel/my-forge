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
        manifestTask({ id: "T-1", ownerAgent: "alpha", expectedOutputs: ["one.txt"], validationCommands: [
          "grep -qx one one.txt",
          // Repository commands never see worker secrets (P6-04): the real
          // process environment carries POSTGRES_TEST_URL, the grant GH_TOKEN.
          'test -z "$POSTGRES_TEST_URL$DATABASE_URL$GH_TOKEN" && test "$HOME" != /root',
        ] }),
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

test("execution host publishes declared work artifacts and projects them into dependent tasks", {
  skip: !connectionString && "POSTGRES_TEST_URL is not set",
}, async () => {
  const fixture = await createExecutionFixture(connectionString!, { label: "host-artifacts" });
  try {
    const submission = acceptedSubmission({
      repositoryId: fixture.repositoryId,
      phases: [{
        id: "phase-1",
        tasks: [
          {
            ...manifestTask({ id: "A-1", ownerAgent: "alpha", expectedOutputs: ["a.txt"], validationCommands: ["grep -qx a a.txt"] }),
            produces: "work.a-1",
          },
          {
            ...manifestTask({ id: "A-2", ownerAgent: "alpha", dependencies: ["A-1"], expectedOutputs: ["b.txt"], validationCommands: ["grep -qx b b.txt"] }),
            produces: "work.a-2",
            inputs: ["work.a-1"],
          },
          {
            ...manifestTask({ id: "A-3", ownerAgent: "alpha", dependencies: ["A-1"], expectedOutputs: ["c.txt"], validationCommands: ["grep -qx c c.txt"] }),
            produces: "work.a-3",
            inputs: ["work.a-1"],
          },
        ],
      }],
      settings: { maxRetries: 0 },
    });
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const harness = new ScriptedHarness((request) => {
      if (request.task.id !== "A-1") {
        assert.match(request.contextBlock, /Completed A-1\./);
      }
      const name = ({ "A-1": "a", "A-2": "b", "A-3": "c" } as Record<string, string>)[request.task.id]!;
      return { files: { [`${name}.txt`]: `${name}\n` } };
    });
    const run = executionHostRunFromSubmission(runId, submission, {
      agentFor: (task) => agent(task.ownerAgent!),
      harness,
    });
    await fixture.status.createRun({
      schemaVersion: 1,
      runId,
      repositoryId: fixture.repositoryId,
      targetRef: TARGET_REF,
      manifestDigest: submission.manifestDigest,
      taskIds: [...submission.selection.effectiveTaskIds],
    });
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
      workerId: "host-artifacts-test",
      budgetMs: 60_000,
      heartbeatIntervalMs: 200,
      heartbeatTtlMs: 5_000,
      inheritedEnvironment: { PATH: process.env.PATH },
    });
    const input = (taskId: string): ExecuteTaskActivityInputV1 => ({
      runId,
      taskId,
      manifestDigest: submission.manifestDigest,
      logicalAttempt: 1,
      operationId: taskOperationId(runId, taskId, 1),
      allowNoop: false,
    });

    const first = await host.executeTask(input("A-1"));
    assert.equal(first.status, "complete", JSON.stringify(first));
    const firstEvidence = (first as Extract<TaskActivityOutcomeV1, { status: "complete" }>).evidence;
    assert.equal(firstEvidence.artifactRefs.length, 3);
    const workRef = firstEvidence.artifactRefs[0]!;
    assert.equal(workRef.retentionClass, "checkpoint-evidence");
    const resolved = await fixture.checkpoints.resolveArtifact(workRef);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      const artifact = JSON.parse(new TextDecoder().decode(resolved.bytes)) as Record<string, unknown>;
      assert.equal(artifact.type, "work.a-1");
      assert.equal(artifact.category, "work");
      assert.equal(artifact.taskId, "A-1");
      assert.equal(artifact.producedBy, "alpha");
      assert.equal(artifact.summary, "Completed A-1.");
    }

    const [second, third] = await Promise.all([host.executeTask(input("A-2")), host.executeTask(input("A-3"))]);
    assert.equal(second.status, "complete", JSON.stringify(second));
    assert.equal(third.status, "complete", JSON.stringify(third));
    const secondEvidence = (second as Extract<TaskActivityOutcomeV1, { status: "complete" }>).evidence;
    const thirdEvidence = (third as Extract<TaskActivityOutcomeV1, { status: "complete" }>).evidence;
    assert.equal(secondEvidence.artifactRefs.length, 3);
    assert.equal(thirdEvidence.artifactRefs.length, 3);
    assert.ok((await fixture.checkpoints.resolveArtifact(secondEvidence.artifactRefs[0]!)).ok);
    assert.ok((await fixture.checkpoints.resolveArtifact(thirdEvidence.artifactRefs[0]!)).ok);
    assert.equal(harness.invocations.length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("execution host neither integrates nor starts attempts once the run is cancelling", {
  skip: !connectionString && "POSTGRES_TEST_URL is not set",
}, async () => {
  const fixture = await createExecutionFixture(connectionString!, { label: "host-cancel" });
  try {
    const submission = acceptedSubmission({
      repositoryId: fixture.repositoryId,
      phases: [{
        id: "phase-1",
        tasks: [manifestTask({ id: "T-1", ownerAgent: "alpha", expectedOutputs: ["one.txt"], validationCommands: ["grep -qx one one.txt"] })],
      }],
      settings: { maxRetries: 1 },
    });
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    await fixture.status.createRun({
      schemaVersion: 1,
      runId,
      repositoryId: fixture.repositoryId,
      targetRef: TARGET_REF,
      manifestDigest: submission.manifestDigest,
      taskIds: [...submission.selection.effectiveTaskIds],
    });
    await fixture.status.appendEvent({ schemaVersion: 1, runId, eventKey: "run:started", eventType: "run.started", runStatus: "running" });
    let cancelling: Promise<unknown> | undefined;
    // The cancel lands while the attempt runs, after its harness effect but before integration.
    const harness = new ScriptedHarness(() => {
      cancelling = fixture.status.appendEvent({
        schemaVersion: 1,
        runId,
        eventKey: "run:cancelling:test",
        eventType: "run.cancelling",
        runStatus: "cancelling",
      });
      return { files: { "one.txt": "one\n" }, delayMs: 200 };
    });
    const run = executionHostRunFromSubmission(runId, submission, { agentFor: (task) => agent(task.ownerAgent!), harness });
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
      workerId: "host-cancel-test",
      budgetMs: 60_000,
      heartbeatIntervalMs: 200,
      heartbeatTtlMs: 5_000,
      inheritedEnvironment: { PATH: process.env.PATH },
    });
    const input = (logicalAttempt: number): ExecuteTaskActivityInputV1 => ({
      runId,
      taskId: "T-1",
      manifestDigest: submission.manifestDigest,
      logicalAttempt,
      operationId: taskOperationId(runId, "T-1", logicalAttempt),
      allowNoop: false,
    });

    const late = await host.executeTask(input(1));
    await cancelling;
    assert.deepEqual(late, { status: "failed", retryable: false, failureCode: "run-cancelled", reason: "The run was cancelled" });
    assert.equal(git(fixture.target, ["rev-parse", TARGET_REF]), fixture.base);

    const next = await host.executeTask(input(2));
    assert.equal(next.status, "failed");
    assert.equal((next as Extract<TaskActivityOutcomeV1, { status: "failed" }>).failureCode, "run-cancelled");
    assert.equal(harness.invocations.length, 1);
    assert.equal(git(fixture.target, ["rev-parse", TARGET_REF]), fixture.base);
  } finally {
    await fixture.cleanup();
  }
});

test("a failure that lands while the run is cancelling is not retryable", {
  skip: !connectionString && "POSTGRES_TEST_URL is not set",
}, async () => {
  const fixture = await createExecutionFixture(connectionString!, { label: "host-cancel-fail" });
  try {
    const submission = acceptedSubmission({
      repositoryId: fixture.repositoryId,
      phases: [{
        id: "phase-1",
        tasks: [manifestTask({ id: "T-1", ownerAgent: "alpha", expectedOutputs: ["one.txt"], validationCommands: ["grep -qx one one.txt"] })],
      }],
      settings: { maxRetries: 1 },
    });
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    await fixture.status.createRun({
      schemaVersion: 1,
      runId,
      repositoryId: fixture.repositoryId,
      targetRef: TARGET_REF,
      manifestDigest: submission.manifestDigest,
      taskIds: [...submission.selection.effectiveTaskIds],
    });
    await fixture.status.appendEvent({ schemaVersion: 1, runId, eventKey: "run:started", eventType: "run.started", runStatus: "running" });
    let cancelling: Promise<unknown> | undefined;
    // The cancel lands while the attempt runs, after its harness effect but before integration.
    const harness = new ScriptedHarness(() => {
      cancelling = fixture.status.appendEvent({
        schemaVersion: 1,
        runId,
        eventKey: "run:cancelling:test",
        eventType: "run.cancelling",
        runStatus: "cancelling",
      });
      return { files: { "one.txt": "wrong\n" }, delayMs: 200 };
    });
    const run = executionHostRunFromSubmission(runId, submission, { agentFor: (task) => agent(task.ownerAgent!), harness });
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
      workerId: "host-cancel-fail-test",
      budgetMs: 60_000,
      heartbeatIntervalMs: 200,
      heartbeatTtlMs: 5_000,
      inheritedEnvironment: { PATH: process.env.PATH },
    });
    const input = (logicalAttempt: number): ExecuteTaskActivityInputV1 => ({
      runId,
      taskId: "T-1",
      manifestDigest: submission.manifestDigest,
      logicalAttempt,
      operationId: taskOperationId(runId, "T-1", logicalAttempt),
      allowNoop: false,
    });

    const failed = await host.executeTask(input(1));
    await cancelling;
    assert.equal(failed.status, "failed");
    const outcome = failed as Extract<TaskActivityOutcomeV1, { status: "failed" }>;
    assert.equal(outcome.failureCode, "validation-failed");
    assert.equal(outcome.retryable, false);
    assert.equal(git(fixture.target, ["rev-parse", TARGET_REF]), fixture.base);
  } finally {
    await fixture.cleanup();
  }
});
