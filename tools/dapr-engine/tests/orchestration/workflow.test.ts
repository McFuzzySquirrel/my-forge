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
  APPLY_RUN_CONTROL_ACTIVITY_NAME,
  GET_RUN_CONTROL_ACTIVITY_NAME,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  TASK_CONTROL_EVENT_NAME,
  TASK_ATTEMPT_WORKFLOW_NAME,
  runOrchestrationWorkflow,
  taskAttemptWorkflow,
  taskAttemptWorkflowId,
  taskAttemptWorkflowIdForAttempt,
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

function mockContext(options: {
  readonly activityResult?: (name: string, input: unknown) => unknown;
} = {}) {
  const childCalls: Array<{ name: string; input: unknown; instanceId: string }> = [];
  const activityCalls: Array<{ name: string; input: unknown }> = [];
  const timers: Array<Date | number> = [];
  const eventWaits: string[] = [];
  const eventTasks: Array<{ kind: string; name: string; getResult(): unknown }> = [];
  const customStatuses: unknown[] = [];
  let eventResult: unknown;
  let waveResult: unknown;
  const context = {
    callActivity(name: string, input: unknown) {
      activityCalls.push({ name, input });
      return { kind: "activity", input, result: options.activityResult?.(name, input) };
    },
    callChildWorkflow(name: string, input: unknown, instanceId: string) {
      childCalls.push({ name, input, instanceId });
      return { kind: "child", instanceId };
    },
    whenAll(tasks: unknown[]) {
      return { kind: "all", tasks, getResult: () => waveResult };
    },
    whenAny(tasks: unknown[]) {
      return { kind: "any", tasks };
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
      const task = { kind: "event", name, getResult: () => eventResult };
      eventTasks.push(task);
      return task;
    },
  } as unknown as WorkflowContext;
  return {
    context,
    childCalls,
    activityCalls,
    timers,
    eventWaits,
    eventTasks,
    customStatuses,
    setEventResult(value: unknown) { eventResult = value; },
    setWaveResult(value: unknown) { waveResult = value; },
  };
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
  const workflow = runOrchestrationWorkflow(context, { runId: "run-1", submission: run, controlsEnabled: false });

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
  const workflow = runOrchestrationWorkflow(context, { runId: "run-fail", submission: run, controlsEnabled: false });

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

test("run cancellation applies cleanup before rejecting the active wave outcomes", async () => {
  const controlId = "11111111-1111-4111-8111-111111111111";
  const runId = "run-cancel";
  const record = {
    controlId,
    runId,
    action: "cancel",
    state: "accepted",
    payload: {},
  };
  const applied = { ...record, state: "applied" };
  const harness = mockContext({
    activityResult(name) {
      if (name === GET_RUN_CONTROL_ACTIVITY_NAME) return record;
      if (name === APPLY_RUN_CONTROL_ACTIVITY_NAME) return applied;
      return undefined;
    },
  });
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId,
    submission: acceptedSubmission({
      manifestSnapshot: { phases: [{ id: "P1", tasks: [{ id: "T1" }] }] },
    }),
    controlsEnabled: true,
  });

  const dispatched = await workflow.next();
  const controlWait = (dispatched.value as unknown as { tasks: unknown[] }).tasks[1];
  harness.setEventResult({ controlId });
  const fetching = await workflow.next(controlWait);
  assert.equal(harness.activityCalls.at(-1)?.name, GET_RUN_CONTROL_ACTIVITY_NAME);
  const applying = await workflow.next(record);
  assert.equal(harness.activityCalls.at(-1)?.name, APPLY_RUN_CONTROL_ACTIVITY_NAME);
  const cancelled = await workflow.next(applied);
  assert.equal(cancelled.done, true);
  assert.deepEqual(cancelled.value, {
    status: "cancelled",
    taskStatuses: { T1: "cancelled" },
  });
  assert.equal(fetching.done, false);
  assert.equal(applying.done, false);
});

test("pause applies after the active task boundary and waits for a durable resume", async () => {
  const runId = "run-pause";
  const pauseId = "33333333-3333-4333-8333-333333333333";
  const resumeId = "44444444-4444-4444-8444-444444444444";
  const pauseRecord = { controlId: pauseId, runId, action: "pause", state: "accepted", payload: {} };
  const resumeRecord = { controlId: resumeId, runId, action: "resume", state: "accepted", payload: {} };
  const pauseApplied = { ...pauseRecord, state: "applied" };
  const resumeApplied = { ...resumeRecord, state: "applied" };
  const records = new Map([[pauseId, pauseRecord], [resumeId, resumeRecord]]);
  const results = new Map([[pauseId, pauseApplied], [resumeId, resumeApplied]]);
  const harness = mockContext({
    activityResult(name, input) {
      const controlId = (input as { controlId: string }).controlId;
      if (name === GET_RUN_CONTROL_ACTIVITY_NAME) return records.get(controlId);
      if (name === APPLY_RUN_CONTROL_ACTIVITY_NAME) return results.get(controlId);
      return undefined;
    },
  });
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId,
    submission: acceptedSubmission({
      manifestSnapshot: { phases: [{ id: "P1", tasks: [{ id: "T1" }] }] },
    }),
    controlsEnabled: true,
  });

  const activeWave = await workflow.next();
  const eventTask = (activeWave.value as unknown as { tasks: unknown[] }).tasks[1];
  harness.setEventResult({ controlId: pauseId });
  const fetchingPause = await workflow.next(eventTask);
  const applyingPause = await workflow.next(pauseRecord);
  assert.equal(harness.activityCalls.at(-1)?.name, APPLY_RUN_CONTROL_ACTIVITY_NAME);
  const waitingForResume = await workflow.next(pauseApplied);
  assert.equal(waitingForResume.done, false);
  assert.equal(harness.customStatuses.at(-1), "paused");

  harness.setEventResult({ controlId: resumeId });
  const fetchingResume = await workflow.next({ controlId: resumeId });
  assert.equal(harness.activityCalls.at(-1)?.name, GET_RUN_CONTROL_ACTIVITY_NAME);
  const applyingResume = await workflow.next(resumeRecord);
  assert.equal(harness.activityCalls.at(-1)?.name, APPLY_RUN_CONTROL_ACTIVITY_NAME);
  const waitingForWave = await workflow.next(resumeApplied);
  assert.equal(waitingForWave.done, false);
  const terminal = await workflow.next([
    childCompleteOutcome(harness.childCalls[0]!.input as {
      runId: string; taskId: string; manifestDigest: string;
    }),
  ]);
  assert.equal(terminal.done, false);
  assert.equal(harness.customStatuses.at(-1), "complete");
  assert.equal(fetchingPause.done, false);
  assert.equal(applyingPause.done, false);
  assert.equal(fetchingResume.done, false);
  assert.equal(applyingResume.done, false);
});

test("terminal runs remain replayable and start a new logical attempt", async () => {
  const runId = "run-replay";
  const controlId = "22222222-2222-4222-8222-222222222222";
  const record = {
    controlId,
    runId,
    action: "replay-task",
    state: "accepted",
    payload: { taskId: "T1" },
  };
  const applied = { ...record, state: "applied", replayLogicalAttempt: 4 };
  const harness = mockContext({
    activityResult(name) {
      if (name === GET_RUN_CONTROL_ACTIVITY_NAME) return record;
      if (name === APPLY_RUN_CONTROL_ACTIVITY_NAME) return applied;
      return undefined;
    },
  });
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId,
    submission: acceptedSubmission({
      manifestSnapshot: { phases: [{ id: "P1", tasks: [{ id: "T1" }] }] },
    }),
    controlsEnabled: true,
  });

  const firstWave = await workflow.next();
  const firstWaveTask = (firstWave.value as unknown as { tasks: unknown[] }).tasks[0] as { getResult(): unknown };
  harness.setWaveResult([
    childCompleteOutcome(harness.childCalls[0]!.input as {
      runId: string; taskId: string; manifestDigest: string;
    }),
  ]);
  const terminalWait = await workflow.next(firstWaveTask);
  assert.equal(terminalWait.done, false);
  harness.setEventResult({ controlId });
  const fetching = await workflow.next({ controlId });
  assert.equal(harness.activityCalls.at(-1)?.name, GET_RUN_CONTROL_ACTIVITY_NAME);
  const applying = await workflow.next(record);
  assert.equal(harness.activityCalls.at(-1)?.name, APPLY_RUN_CONTROL_ACTIVITY_NAME);
  const replayWave = await workflow.next(applied);
  assert.equal(replayWave.done, false);
  const replay = harness.childCalls.at(-1)!;
  assert.equal(replay.input && (replay.input as { initialLogicalAttempt: number }).initialLogicalAttempt, 4);
  assert.equal(replay.instanceId, taskAttemptWorkflowIdForAttempt(runId, "T1", 4));
  assert.equal(fetching.done, false);
  assert.equal(applying.done, false);
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
    initialLogicalAttempt: 4,
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
    taskWorkflowInstanceId: string;
    waitId: string;
    controlId: string;
    operationId: string;
  };
  assert.deepEqual(
    {
      runId: resumeInput.runId,
      taskId: resumeInput.taskId,
      logicalAttempt: resumeInput.logicalAttempt,
      taskWorkflowInstanceId: resumeInput.taskWorkflowInstanceId,
      waitId: resumeInput.waitId,
      controlId: resumeInput.controlId,
    },
    {
      runId: input.runId,
      taskId: input.taskId,
      logicalAttempt: 4,
      taskWorkflowInstanceId: taskAttemptWorkflowIdForAttempt(input.runId, input.taskId, 4),
      waitId: "approval-1",
      controlId: "11111111-1111-4111-8111-111111111111",
    },
  );
  assert.equal(
    resumeInput.operationId,
    taskOperationId(input.runId, input.taskId, 4, "resume:approval-1"),
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
