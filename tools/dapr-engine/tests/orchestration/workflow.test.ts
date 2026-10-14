import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowContext, WorkflowRuntime } from "@dapr/dapr";
import {
  buildOrchestrationPlan,
  nextDispatchWave,
  type AcceptedRunSubmissionV1,
  type PlannedTaskV1,
} from "../../orchestration/planner.ts";
import { registerOrchestrationWorkflows } from "../../orchestration/index.ts";
import { createTaskCompletionEvidence } from "../../orchestration/outcome.ts";
import {
  RESUME_TASK_ACTIVITY_NAME,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  TASK_CONTROL_EVENT_NAME,
  TASK_ATTEMPT_WORKFLOW_NAME,
  runOrchestrationWorkflow,
  taskAttemptWorkflow,
  taskAttemptWorkflowId,
  taskOperationId,
} from "../../orchestration/workflow.ts";
import {
  validateSubmission,
  type RunSubmissionV1,
  type TaskStatusV1,
} from "../../contract/v1/index.ts";
import { sampleManifest, submission } from "../conformance/support/fixtures.ts";

const SHA256 = `sha256:${"a".repeat(64)}` as const;

function acceptedSubmission(overrides: Partial<RunSubmissionV1> = {}): AcceptedRunSubmissionV1 {
  const draft = submission(overrides);
  const validation = validateSubmission(draft);
  if (!validation.ok) throw new Error(validation.detail);
  return {
    ...draft,
    selection: { ...draft.selection, effectiveTaskIds: validation.effectiveTaskIds },
  };
}

function completeOutcome(input: {
  runId: string;
  taskId: string;
  manifestDigest: string;
  logicalAttempt: number;
  operationId: string;
}) {
  return {
    status: "complete" as const,
    evidence: createTaskCompletionEvidence({
      ...input,
      manifestDigest: input.manifestDigest as `sha256:${string}`,
      outputFiles: [],
      handoffDigest: SHA256,
      artifactRefs: [],
      validationCommands: [],
    }),
  };
}

function childCompleteOutcome(input: { runId: string; taskId: string; manifestDigest: string }) {
  return completeOutcome({
    ...input,
    logicalAttempt: 1,
    operationId: taskOperationId(input.runId, input.taskId, 1),
  });
}

function mockContext() {
  const childCalls: Array<{ name: string; input: unknown; instanceId: string }> = [];
  const activityCalls: Array<{ name: string; input: unknown }> = [];
  const timers: Array<Date | number> = [];
  const eventWaits: string[] = [];
  const customStatuses: unknown[] = [];
  const context = {
    callActivity(name: string, input: unknown) {
      activityCalls.push({ name, input });
      return { kind: "activity", input };
    },
    callChildWorkflow(name: string, input: unknown, instanceId: string) {
      childCalls.push({ name, input, instanceId });
      return { kind: "child", instanceId };
    },
    whenAll(tasks: unknown[]) {
      return { kind: "all", tasks };
    },
    createTimer(deadline: Date | number) {
      timers.push(deadline);
      return { kind: "timer", deadline };
    },
    getCurrentUtcDateTime() {
      return new Date(1_000);
    },
    setCustomStatus(status: unknown) {
      customStatuses.push(status);
    },
    waitForExternalEvent(name: string) {
      eventWaits.push(name);
      return { kind: "event", name };
    },
  } as unknown as WorkflowContext;
  return { context, childCalls, activityCalls, timers, eventWaits, customStatuses };
}

test("plan expands selection using task and phase prerequisites in manifest order", () => {
  const manifest = sampleManifest();
  const run = acceptedSubmission({
    manifestSnapshot: manifest,
    selection: { mode: "manual", requestedTaskIds: ["T3"] },
  });
  const plan = buildOrchestrationPlan(run);

  assert.deepEqual(plan.tasks.map((task) => task.taskId), ["T1", "T2", "T3"]);
  assert.deepEqual(plan.tasks.find((task) => task.taskId === "T3")?.prerequisites, ["T1", "T2"]);
  assert.deepEqual(
    { concurrency: plan.maxConcurrency, retries: plan.maxRetries, retryDelayMs: plan.retryDelayMs, allowNoop: plan.allowNoop },
    { concurrency: 1, retries: 2, retryDelayMs: 5_000, allowNoop: false },
  );
});

test("dispatch waves obey dependencies, manifest order, owner exclusivity, and concurrency", () => {
  const tasks: PlannedTaskV1[] = [
    { taskId: "unassigned-1", prerequisites: [] },
    { taskId: "unassigned-2", prerequisites: [] },
    { taskId: "owned-1", ownerAgent: "agent-a", prerequisites: [] },
    { taskId: "owned-2", ownerAgent: "agent-a", prerequisites: [] },
    { taskId: "dependent", ownerAgent: "agent-b", prerequisites: ["owned-1"] },
  ];
  const statuses: Record<string, TaskStatusV1> = Object.fromEntries(tasks.map((task) => [task.taskId, "pending"]));

  assert.deepEqual(
    nextDispatchWave(tasks, statuses, 3).map((task) => task.taskId),
    ["unassigned-1", "owned-1"],
  );
  statuses["owned-1"] = "skipped";
  assert.deepEqual(
    nextDispatchWave(tasks, statuses, 3).map((task) => task.taskId),
    ["unassigned-1", "owned-2", "dependent"],
  );
});

test("workflow waits for a wave, then dispatches tasks whose prerequisites completed or skipped", async () => {
  const manifest = {
    phases: [
      {
        id: "P1",
        tasks: [
          { id: "first", ownerAgent: "agent-a" },
          { id: "second", ownerAgent: "agent-b" },
        ],
      },
      {
        id: "P2",
        dependencies: ["P1"],
        tasks: [{ id: "third", ownerAgent: "agent-a" }],
      },
    ],
  };
  const run = acceptedSubmission({
    manifestSnapshot: manifest,
    configuration: {
      settings: { concurrency: 2, maxRetries: 0 },
      secretRefs: {},
    },
  });
  const { context, childCalls } = mockContext();
  const workflow = runOrchestrationWorkflow(context, { runId: "run-1", submission: run });

  const firstWave = await workflow.next();
  assert.equal(firstWave.done, false);
  assert.deepEqual(childCalls.map((call) => call.input && (call.input as { taskId: string }).taskId), ["first", "second"]);
  assert.equal(new Set(childCalls.map((call) => call.instanceId)).size, 2);
  assert.deepEqual(
    childCalls.map((call) => {
      const input = call.input as { maxRetries: number; retryDelayMs: number; allowNoop: boolean };
      return { maxRetries: input.maxRetries, retryDelayMs: input.retryDelayMs, allowNoop: input.allowNoop };
    }),
    [{ maxRetries: 0, retryDelayMs: 5_000, allowNoop: false }, { maxRetries: 0, retryDelayMs: 5_000, allowNoop: false }],
  );

  const secondWave = await workflow.next([
    childCompleteOutcome(childCalls[0]!.input as { runId: string; taskId: string; manifestDigest: string }),
    { status: "skipped" },
  ]);
  assert.equal(secondWave.done, false);
  assert.equal(childCalls.at(-1)?.input && (childCalls.at(-1)!.input as { taskId: string }).taskId, "third");

  const complete = await workflow.next([childCompleteOutcome(childCalls.at(-1)!.input as {
    runId: string; taskId: string; manifestDigest: string;
  })]);
  assert.deepEqual(complete.value, {
    status: "complete",
    taskStatuses: { first: "complete", second: "skipped", third: "complete" },
  });
});

test("workflow stops dispatch after a terminal task failure", async () => {
  const run = acceptedSubmission({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: [
        { id: "first", ownerAgent: "agent-a" },
        { id: "second", ownerAgent: "agent-b" },
      ] }],
    },
    configuration: { settings: { concurrency: 2 }, secretRefs: {} },
  });
  const { context, childCalls } = mockContext();
  const workflow = runOrchestrationWorkflow(context, { runId: "run-fail", submission: run });

  await workflow.next();
  const result = await workflow.next([
    { status: "failed", retryable: false, failureCode: "invalid-task" },
    childCompleteOutcome(childCalls[1]!.input as { runId: string; taskId: string; manifestDigest: string }),
  ]);
  assert.deepEqual(result.value, {
    status: "failed",
    taskStatuses: { first: "failed", second: "complete" },
  });
  assert.equal(childCalls.length, 2);
});

test("task retries use durable time and stable per-attempt operation identities", async () => {
  const { context, activityCalls, timers } = mockContext();
  const input = {
    runId: "run-retry",
    taskId: "task/one",
    manifestDigest: SHA256,
    maxRetries: 2,
    retryDelayMs: 5_000,
    allowNoop: false,
  };
  const workflow = taskAttemptWorkflow(context, input);

  const first = await workflow.next();
  assert.equal(first.done, false);
  const firstActivity = activityCalls[0]!.input as { logicalAttempt: number; operationId: string };
  assert.equal(firstActivity.logicalAttempt, 1);
  assert.match(firstActivity.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(taskOperationId(input.runId, input.taskId, 1), firstActivity.operationId);

  const timer = await workflow.next({ status: "failed", retryable: true });
  assert.equal(timer.done, false);
  assert.deepEqual(timers, [new Date(6_000)]);

  const second = await workflow.next();
  assert.equal(second.done, false);
  const secondActivity = activityCalls[1]!.input as { logicalAttempt: number; operationId: string };
  assert.equal(secondActivity.logicalAttempt, 2);
  assert.notEqual(secondActivity.operationId, firstActivity.operationId);

  const outcome = completeOutcome(activityCalls[1]!.input as {
    runId: string; taskId: string; manifestDigest: string; logicalAttempt: number; operationId: string;
  });
  const complete = await workflow.next(outcome);
  assert.deepEqual(complete.value, outcome);
});

test("task control events durably wake a task but only resumeTask can accept them", async () => {
  const { context, activityCalls, eventWaits, customStatuses } = mockContext();
  const input = {
    runId: "run-wait",
    taskId: "task",
    manifestDigest: SHA256,
    maxRetries: 0,
    retryDelayMs: 0,
    allowNoop: false,
  };
  const workflow = taskAttemptWorkflow(context, input);

  await workflow.next();
  const waiting = await workflow.next({ status: "waiting", waitId: "approval-1" });
  assert.equal(waiting.done, false);
  assert.deepEqual(eventWaits, [TASK_CONTROL_EVENT_NAME]);
  assert.deepEqual(customStatuses, ["waiting-for-control"]);

  const resumed = await workflow.next({ controlId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(resumed.done, false);
  const resumeCall = activityCalls.at(-1)!;
  assert.equal(resumeCall.name, RESUME_TASK_ACTIVITY_NAME);
  const resumeInput = resumeCall.input as {
    runId: string;
    taskId: string;
    logicalAttempt: number;
    waitId: string;
    controlId: string;
    operationId: string;
  };
  assert.deepEqual(
    {
      runId: resumeInput.runId,
      taskId: resumeInput.taskId,
      logicalAttempt: resumeInput.logicalAttempt,
      waitId: resumeInput.waitId,
      controlId: resumeInput.controlId,
    },
    {
      runId: input.runId,
      taskId: input.taskId,
      logicalAttempt: 1,
      waitId: "approval-1",
      controlId: "11111111-1111-4111-8111-111111111111",
    },
  );
  assert.equal(
    resumeInput.operationId,
    taskOperationId(input.runId, input.taskId, 1, "resume:approval-1"),
  );

  const outcome = completeOutcome(resumeCall.input as {
    runId: string; taskId: string; manifestDigest: string; logicalAttempt: number; operationId: string;
  });
  const complete = await workflow.next(outcome);
  assert.deepEqual(complete.value, outcome);

  const invalidContext = mockContext();
  const invalidWorkflow = taskAttemptWorkflow(invalidContext.context, input);
  await invalidWorkflow.next();
  await invalidWorkflow.next({ status: "waiting", waitId: "approval-1" });
  await assert.rejects(invalidWorkflow.next({ controlId: "not-a-control-id" }), /UUID controlId/);
});

test("task workflow rejects a bare successful activity outcome", async () => {
  const { context } = mockContext();
  const workflow = taskAttemptWorkflow(context, {
    runId: "run-no-proof",
    taskId: "task",
    manifestDigest: SHA256,
    maxRetries: 0,
    retryDelayMs: 0,
    allowNoop: false,
  });
  await workflow.next();
  await assert.rejects(workflow.next({ status: "complete" }), /invalid outcome/);
});

test("task retries stop at the configured limit and do not retry unclassified activity failures", async () => {
  const { context, activityCalls, timers } = mockContext();
  const workflow = taskAttemptWorkflow(context, {
    runId: "run-limit",
    taskId: "task",
    manifestDigest: SHA256,
    maxRetries: 1,
    retryDelayMs: 0,
    allowNoop: false,
  });

  await workflow.next();
  await workflow.next({ status: "failed", retryable: true });
  await workflow.next();
  const exhausted = await workflow.next({ status: "failed", retryable: true });
  assert.deepEqual(exhausted.value, { status: "failed", retryable: true });
  assert.equal(activityCalls.length, 2);
  assert.deepEqual(timers, [new Date(1_000)]);

  const failedContext = mockContext();
  const failedWorkflow = taskAttemptWorkflow(failedContext.context, {
    runId: "run-error",
    taskId: "task",
    manifestDigest: SHA256,
    maxRetries: 3,
    retryDelayMs: 10,
    allowNoop: false,
  });
  await failedWorkflow.next();
  const activityFailure = await failedWorkflow.throw(new Error("activity failed"));
  assert.deepEqual(activityFailure.value, {
    status: "failed",
    retryable: false,
    failureCode: "activity-failed",
  });
  assert.deepEqual(failedContext.timers, []);
});

test("planner rejects cycles, mismatched frozen selections, and invalid limits", () => {
  const cyclic = acceptedSubmission({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: [{ id: "A", dependencies: ["B"] }, { id: "B", dependencies: ["A"] }] }],
    },
  });
  assert.throws(() => buildOrchestrationPlan(cyclic), /dependency cycle/);

  const valid = acceptedSubmission();
  const mismatched = {
    ...valid,
    selection: { ...valid.selection, effectiveTaskIds: ["not-in-snapshot"] },
  } as AcceptedRunSubmissionV1;
  assert.throws(() => buildOrchestrationPlan(mismatched), /Frozen effective task selection/);

  const invalidLimits = acceptedSubmission({
    configuration: { settings: { concurrency: 0 }, secretRefs: {} },
  });
  assert.throws(() => buildOrchestrationPlan(invalidLimits), /configuration.settings.concurrency/);

  const invalidNoopPolicy = acceptedSubmission({
    configuration: { settings: { allowNoop: "true" }, secretRefs: {} },
  });
  assert.throws(() => buildOrchestrationPlan(invalidNoopPolicy), /configuration.settings.allowNoop must be a boolean/);
});

test("registers stable workflow names for the run and task-attempt orchestrators", () => {
  const registrations: Array<{ name: string; workflow: unknown }> = [];
  const runtime = {
    registerWorkflowWithName(name: string, workflow: unknown) {
      registrations.push({ name, workflow });
      return this;
    },
  } as unknown as WorkflowRuntime;

  assert.equal(registerOrchestrationWorkflows(runtime), runtime);
  assert.deepEqual(registrations.map(({ name }) => name), [
    RUN_ORCHESTRATION_WORKFLOW_NAME,
    TASK_ATTEMPT_WORKFLOW_NAME,
  ]);
  assert.equal(registrations[0]?.workflow, runOrchestrationWorkflow);
  assert.equal(registrations[1]?.workflow, taskAttemptWorkflow);
  assert.equal(
    taskAttemptWorkflowId("run-1", "task-1"),
    `forge-task-${taskOperationId("run-1", "task-1", 1)}`,
  );
});
