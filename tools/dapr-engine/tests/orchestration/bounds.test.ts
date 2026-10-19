import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowRuntime, type WorkflowContext } from "@dapr/dapr";
import { validateSubmission, type RunSubmissionV1 } from "../../contract/v1/index.ts";
import {
  DAPR_SDK_WORKER_LIMITS,
  MAX_WORKER_TASK_ATTEMPTS,
  RUN_LIMITS_V1,
} from "../../orchestration/limits.ts";
import { buildOrchestrationPlan, type AcceptedRunSubmissionV1 } from "../../orchestration/planner.ts";
import { boundTaskExecutionOutcome, createTaskCompletionEvidence, MAX_FAILURE_REASON_CHARS } from "../../orchestration/outcome.ts";
import { createListAcceptedRunControlsActivity } from "../../orchestration/run-control.ts";
import { RunAdmissionController } from "../../orchestration/worker-capacity.ts";
import {
  APPLY_RUN_CONTROL_ACTIVITY_NAME,
  EXECUTE_TASK_ACTIVITY_NAME,
  GET_RUN_CONTROL_ACTIVITY_NAME,
  LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME,
  RESUME_TASK_ACTIVITY_NAME,
  runOrchestrationWorkflow,
  taskAttemptWorkflow,
  taskAttemptWorkflowIdForAttempt,
  taskOperationId,
  type RunWorkflowInputV1,
} from "../../orchestration/workflow.ts";
import { ARTIFACT_SIZE_LIMITS, FileArtifactCheckpointStore } from "../../storage/files/artifact-checkpoint-store.ts";
import type { StoredControlRecordV1 } from "../../storage/postgres/control-records.ts";
import { submission } from "../conformance/support/fixtures.ts";

const SHA256 = `sha256:${"a".repeat(64)}` as const;

function accepted(overrides: Partial<RunSubmissionV1> = {}): AcceptedRunSubmissionV1 {
  const draft = submission(overrides);
  const validation = validateSubmission(draft);
  if (!validation.ok) throw new Error(validation.detail);
  return { ...draft, selection: { ...draft.selection, effectiveTaskIds: validation.effectiveTaskIds } };
}

function sequentialRun(taskCount: number, settings: Record<string, number | boolean> = {}): AcceptedRunSubmissionV1 {
  return accepted({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: Array.from({ length: taskCount }, (_, index) => ({ id: `T${index + 1}`, ownerAgent: "a" })) }],
    },
    configuration: { settings: { maxRetries: 0, ...settings }, secretRefs: {} },
  });
}

function complete(runId: string, taskId: string, manifestDigest: string, logicalAttempt = 1) {
  return {
    status: "complete" as const,
    evidence: createTaskCompletionEvidence({
      runId,
      taskId,
      manifestDigest: manifestDigest as `sha256:${string}`,
      logicalAttempt,
      operationId: taskOperationId(runId, taskId, logicalAttempt),
      outputFiles: [],
      handoffDigest: SHA256,
      artifactRefs: [],
      validationCommands: [],
    }),
  };
}

interface MockTask { kind: string; isComplete?: boolean; getResult?(): unknown; tasks?: unknown[] }

function mockContext(activityResult: (name: string, input: unknown) => unknown = () => undefined) {
  const childCalls: Array<{ input: { taskId: string }; instanceId: string }> = [];
  const activityCalls: Array<{ name: string; input: unknown }> = [];
  const eventTasks: MockTask[] = [];
  const continued: Array<{ input: RunWorkflowInputV1; saveEvents: boolean }> = [];
  let eventResult: unknown;
  let waveResult: unknown;
  const childTasks: Array<{ isComplete: boolean; result: unknown }> = [];
  const context = {
    callActivity(name: string, input: unknown) {
      activityCalls.push({ name, input });
      return { kind: "activity", result: activityResult(name, input) };
    },
    callChildWorkflow(_name: string, input: { taskId: string }, instanceId: string) {
      childCalls.push({ input, instanceId });
      const task = { kind: "child", isComplete: false, result: undefined as unknown, getResult() { return this.result; } };
      childTasks.push(task);
      return task;
    },
    whenAll(tasks: unknown[]) { return { kind: "all", tasks, getResult: () => waveResult }; },
    whenAny(tasks: unknown[]) { return { kind: "any", tasks }; },
    createTimer() { return { kind: "timer" }; },
    getCurrentUtcDateTime() { return new Date(1_000); },
    setCustomStatus() {},
    waitForExternalEvent() {
      const task: MockTask = { kind: "event", getResult: () => eventResult };
      eventTasks.push(task);
      return task;
    },
    continueAsNew(input: RunWorkflowInputV1, saveEvents: boolean) { continued.push({ input, saveEvents }); },
  } as unknown as WorkflowContext;
  return {
    context, childCalls, activityCalls, eventTasks, continued,
    setEventResult(value: unknown) { eventResult = value; },
    setWaveResult(value: unknown) {
      waveResult = value;
      // Complete the latest wave's children, as the real SDK completes each child task.
      if (Array.isArray(value)) {
        childTasks.slice(-value.length).forEach((task, index) => {
          task.isComplete = true;
          task.result = value[index];
        });
      }
    },
  };
}

test("planner enforces P4-06 ceilings instead of clamping configuration", () => {
  const plan = buildOrchestrationPlan(sequentialRun(2));
  assert.equal(plan.historyRolloverUnits, RUN_LIMITS_V1.defaultHistoryRolloverUnits);
  assert.equal(buildOrchestrationPlan(sequentialRun(2, { historyRolloverUnits: 4 })).historyRolloverUnits, 4);
  for (const [key, value] of [
    ["concurrency", RUN_LIMITS_V1.maxConcurrency + 1],
    ["maxRetries", RUN_LIMITS_V1.maxRetries + 1],
    ["retryDelayMs", RUN_LIMITS_V1.maxRetryDelayMs + 1],
    ["historyRolloverUnits", 0],
    ["historyRolloverUnits", RUN_LIMITS_V1.maxHistoryRolloverUnits + 1],
  ] as const) {
    assert.throws(() => buildOrchestrationPlan(sequentialRun(2, { [key]: value })), new RegExp(`settings\\.${key}`));
  }
  assert.equal(
    buildOrchestrationPlan(sequentialRun(10, { concurrency: RUN_LIMITS_V1.maxConcurrency })).maxConcurrency,
    RUN_LIMITS_V1.maxConcurrency,
  );
});

test("planner rejects runs above the task-count and workflow-input budgets", () => {
  const tooMany = accepted({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: Array.from({ length: RUN_LIMITS_V1.maxTasksPerRun + 1 }, (_, index) => ({ id: `T${index}` })) }],
    },
  });
  assert.throws(() => buildOrchestrationPlan(tooMany), /at most 1000 tasks/);
  const oversized = accepted({
    manifestSnapshot: { phases: [{ id: "P1", tasks: [{ id: "T1" }] }] },
    configuration: { settings: { note: "x".repeat(RUN_LIMITS_V1.maxWorkflowInputBytes) }, secretRefs: {} },
  });
  assert.throws(() => buildOrchestrationPlan(oversized), /workflow input limit/);
});

test("run workflow continues as new at a task boundary and the next generation keeps task identity", async () => {
  const runId = "run-rollover";
  const run = sequentialRun(3, { historyRolloverUnits: 2 });
  const first = mockContext();
  const generation0 = runOrchestrationWorkflow(first.context, {
    runId, submission: run, controlsEnabled: false, statusEnabled: false,
  });
  await generation0.next();
  await generation0.next([complete(runId, "T1", run.manifestDigest)]);
  const rolled = await generation0.next([complete(runId, "T2", run.manifestDigest)]);
  assert.equal(rolled.done, true);
  assert.equal(rolled.value.status, "continued");
  assert.deepEqual(first.childCalls.map((call) => call.input.taskId), ["T1", "T2"]);
  assert.equal(first.continued.length, 1);
  const { input: next, saveEvents } = first.continued[0]!;
  assert.equal(saveEvents, true);
  assert.equal(next.submission, run);
  assert.deepEqual(next.continuation, {
    schemaVersion: 1,
    generation: 1,
    statuses: { T1: "complete", T2: "complete", T3: "pending" },
    nextLogicalAttempt: { T1: 1, T2: 1, T3: 1 },
    runCycle: 0,
  });

  const second = mockContext();
  const generation1 = runOrchestrationWorkflow(second.context, next);
  await generation1.next();
  assert.deepEqual(second.childCalls.map((call) => call.instanceId), [taskAttemptWorkflowIdForAttempt(runId, "T3", 1)]);
  assert.equal(second.activityCalls.length, 0, "a continued generation does not re-record run.started");
  const done = await generation1.next([complete(runId, "T3", run.manifestDigest)]);
  assert.deepEqual(done.value, {
    status: "complete",
    taskStatuses: { T1: "complete", T2: "complete", T3: "complete" },
  });
});

test("run continuation is validated against the immutable plan", async () => {
  const run = sequentialRun(2);
  const base = { schemaVersion: 1, generation: 1, nextLogicalAttempt: { T1: 1, T2: 1 }, runCycle: 0 } as const;
  for (const statuses of [
    { T1: "running", T2: "pending" },
    { T1: "complete" },
    { T1: "complete", T2: "complete" },
    { T1: "complete", T3: "pending" },
  ]) {
    const harness = mockContext();
    const workflow = runOrchestrationWorkflow(harness.context, {
      runId: "run-invalid", submission: run, controlsEnabled: false, statusEnabled: false,
      continuation: { ...base, statuses } as never,
    });
    await assert.rejects(workflow.next(), /continu/);
  }
});

test("a continued generation drains accepted controls before waiting for new wakes", async () => {
  const runId = "run-recover";
  const pauseId = "33333333-3333-4333-8333-333333333333";
  const resumeId = "44444444-4444-4444-8444-444444444444";
  const records = new Map<string, Record<string, unknown>>([
    [pauseId, { controlId: pauseId, runId, action: "pause", state: "accepted", payload: {} }],
    [resumeId, { controlId: resumeId, runId, action: "resume", state: "accepted", payload: {} }],
  ]);
  const harness = mockContext((name, input) => {
    if (name === LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME) return undefined;
    const controlId = (input as { controlId: string }).controlId;
    const record = records.get(controlId);
    if (name === APPLY_RUN_CONTROL_ACTIVITY_NAME) return { ...record, state: "applied" };
    return record;
  });
  const run = sequentialRun(2);
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
    continuation: {
      schemaVersion: 1, generation: 3, statuses: { T1: "complete", T2: "pending" },
      nextLogicalAttempt: { T1: 1, T2: 1 }, runCycle: 0,
    },
  });
  const listing = await workflow.next();
  assert.equal(harness.activityCalls.at(-1)?.name, LIST_ACCEPTED_RUN_CONTROLS_ACTIVITY_NAME);
  assert.equal(listing.done, false);
  await workflow.next([pauseId]);
  assert.equal(harness.childCalls.length, 1, "the wave is scheduled before the recovered control is processed");
  assert.equal(harness.activityCalls.at(-1)?.name, GET_RUN_CONTROL_ACTIVITY_NAME);
  await workflow.next(records.get(pauseId));
  const waitingForResume = await workflow.next({ ...records.get(pauseId), state: "applied" });
  assert.equal(waitingForResume.value, harness.eventTasks[0], "the generation's single waiter receives the resume");
  harness.setEventResult({ controlId: resumeId });
  await workflow.next({ controlId: resumeId });
  await workflow.next(records.get(resumeId));
  await workflow.next({ ...records.get(resumeId), state: "applied" });
  const terminalWait = await workflow.next([complete(runId, "T2", run.manifestDigest)]);
  assert.equal(terminalWait.done, false);
  assert.equal(harness.eventTasks.length, 2, "no run-control waiter is orphaned");
  const invalid = runOrchestrationWorkflow(mockContext().context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
    continuation: {
      schemaVersion: 1, generation: 1, statuses: { T1: "complete", T2: "pending" },
      nextLogicalAttempt: { T1: 1, T2: 1 }, runCycle: 0,
    },
  });
  await invalid.next();
  await assert.rejects(invalid.next(["not-a-control-id"]), /invalid control IDs/);
});

test("rollover waits while a control wake is already delivered", async () => {
  const runId = "run-delivered";
  const run = sequentialRun(3, { historyRolloverUnits: 1 });
  const harness = mockContext();
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
  });
  const firstWave = await workflow.next();
  const waveTask = (firstWave.value as unknown as MockTask).tasks![0];
  harness.setWaveResult([complete(runId, "T1", run.manifestDigest)]);
  harness.eventTasks[0]!.isComplete = true;
  const secondWave = await workflow.next(waveTask);
  assert.equal(harness.continued.length, 0);
  assert.equal(harness.childCalls.length, 2);
  harness.eventTasks[0]!.isComplete = false;
  harness.setWaveResult([complete(runId, "T2", run.manifestDigest)]);
  const rolled = await workflow.next((secondWave.value as unknown as MockTask).tasks![0]);
  assert.equal(rolled.done, true);
  assert.equal(harness.continued.length, 1);
});

test("a terminal run ignores a duplicate wake for an already-applied control", async () => {
  const runId = "run-duplicate";
  const pauseId = "33333333-3333-4333-8333-333333333333";
  const harness = mockContext((name) => (name === GET_RUN_CONTROL_ACTIVITY_NAME
    ? { controlId: pauseId, runId, action: "pause", state: "applied", payload: {} }
    : undefined));
  const run = sequentialRun(1);
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
  });
  const dispatched = await workflow.next();
  harness.setWaveResult([complete(runId, "T1", run.manifestDigest)]);
  const terminal = await workflow.next((dispatched.value as unknown as MockTask).tasks![0]);
  assert.equal(terminal.value, harness.eventTasks[0]);
  await workflow.next({ controlId: pauseId });
  const waitingAgain = await workflow.next({ controlId: pauseId, runId, action: "pause", state: "applied", payload: {} });
  assert.equal(waitingAgain.done, false);
  assert.equal(waitingAgain.value, harness.eventTasks[1]);
});

test("a control wake mid-wave waits only on children that are still running", async () => {
  const runId = "run-partial-wave";
  const pauseId = "33333333-3333-4333-8333-333333333333";
  const harness = mockContext();
  const run = accepted({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: [{ id: "T1", ownerAgent: "a" }, { id: "T2", ownerAgent: "b" }] }],
    },
    configuration: { settings: { concurrency: 2, maxRetries: 0 }, secretRefs: {} },
  });
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
  });
  const race = (await workflow.next()).value as unknown as MockTask;
  assert.equal(race.kind, "any");
  const [first, second, event] = race.tasks as Array<MockTask & { result?: unknown }>;
  assert.equal(harness.childCalls.length, 2);
  Object.assign(first!, { isComplete: true, result: complete(runId, "T1", run.manifestDigest) });
  Object.assign(event!, { isComplete: true });
  harness.setEventResult({ controlId: pauseId });
  await workflow.next(event);
  const wave = await workflow.next({ controlId: pauseId, runId, action: "pause", state: "applied", payload: {} });
  const waveTask = wave.value as unknown as MockTask;
  assert.equal(waveTask.kind, "all");
  assert.deepEqual(waveTask.tasks, [second], "a finished child is never handed to the SDK whenAll");
  const terminal = await workflow.next([complete(runId, "T2", run.manifestDigest)]);
  assert.equal(terminal.done, false);
  assert.equal(terminal.value, harness.eventTasks.at(-1), "both outcomes are accepted and the run reaches its terminal wait");
});

test("a task attempt fails closed after the approval-wait limit", async () => {
  const runId = "run-waits";
  const run = sequentialRun(1);
  const harness = mockContext();
  const workflow = taskAttemptWorkflow(harness.context, {
    runId, taskId: "T1", manifestDigest: run.manifestDigest, maxRetries: 3, retryDelayMs: 0,
    allowNoop: false, statusEnabled: false,
  });
  let step = await workflow.next();
  assert.equal(harness.activityCalls.at(-1)?.name, EXECUTE_TASK_ACTIVITY_NAME);
  let waits = 0;
  step = await workflow.next({ status: "waiting", waitId: "approval-1" });
  while (!step.done) {
    waits += 1;
    step = await workflow.next({ controlId: "55555555-5555-4555-8555-555555555555" });
    assert.equal(harness.activityCalls.at(-1)?.name, RESUME_TASK_ACTIVITY_NAME);
    step = await workflow.next({ status: "waiting", waitId: "approval-1" });
  }
  assert.equal(waits, RUN_LIMITS_V1.maxApprovalWaitsPerAttempt);
  assert.deepEqual(step.value, { status: "failed", retryable: false, failureCode: "wait-limit-exceeded" });
});

test("task outcomes are bounded before they enter workflow history", () => {
  const small = { status: "failed" as const, retryable: true, reason: "short" };
  assert.equal(boundTaskExecutionOutcome(small), small);

  const noisy = boundTaskExecutionOutcome({
    status: "failed",
    retryable: true,
    failureCode: "validation-failed",
    reason: "r".repeat(RUN_LIMITS_V1.maxTaskOutcomeBytes),
    gates: [{ gate: "validation", status: "failed", reason: "g".repeat(5_000), evidence: ["e".repeat(10)] }],
  });
  assert.equal(noisy.status, "failed");
  assert.ok(Buffer.byteLength(JSON.stringify(noisy)) <= RUN_LIMITS_V1.maxTaskOutcomeBytes);
  assert.match((noisy as { reason: string }).reason, /truncated/);
  assert.ok((noisy as { reason: string }).reason.length <= MAX_FAILURE_REASON_CHARS);
  assert.equal((noisy as unknown as { gates: unknown[] }).gates.length, 1);
  assert.ok((noisy as unknown as { gates: Array<{ reason: string }> }).gates[0]!.reason.length <= 1_000);

  const manyGates = boundTaskExecutionOutcome({
    status: "failed",
    retryable: false,
    gates: Array.from({ length: 400 }, () => ({
      gate: "validation" as const, status: "failed" as const, evidence: Array.from({ length: 40 }, () => "e".repeat(2_000)),
    })),
  }, 64 * 1024);
  assert.deepEqual(manyGates, { status: "failed", retryable: false });

  const huge = boundTaskExecutionOutcome(complete("run", "T1", SHA256), 512);
  assert.equal(huge.status, "failed");
  assert.equal((huge as { failureCode: string }).failureCode, "outcome-too-large");
  assert.equal((huge as { retryable: boolean }).retryable, false);
});

test("artifact publication rejects payloads above the size budget before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4-06-artifacts-"));
  try {
    const store = new FileArtifactCheckpointStore(root);
    const bytes = new Uint8Array(ARTIFACT_SIZE_LIMITS.maxArtifactBytes + 1);
    assert.deepEqual(
      await store.publishArtifact(bytes, { mediaType: "text/plain", sizeBytes: bytes.byteLength, sha256: SHA256 }),
      { ok: false, code: "artifact-too-large" },
    );
    assert.deepEqual(
      await store.publishArtifact(bytes, { mediaType: "application/vnd.git.bundle", sizeBytes: bytes.byteLength, sha256: SHA256 }),
      { ok: false, code: "artifact-digest-mismatch" },
      "git bundles use the larger bundle budget",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run admission reserves task-attempt slots and rejects runs that would exhaust the worker", () => {
  const admission = new RunAdmissionController();
  assert.equal(admission.maxActiveTaskAttempts, MAX_WORKER_TASK_ATTEMPTS);
  assert.deepEqual(admission.reserve("run-a", 5), { ok: true, runId: "run-a", reserved: 5, available: 3 });
  assert.deepEqual(admission.reserve("run-b", 4), {
    ok: false, code: "worker-capacity-exhausted", requested: 4, available: 3,
  });
  assert.deepEqual(admission.reserve("run-a", 5), { ok: true, runId: "run-a", reserved: 5, available: 3 });
  assert.throws(() => admission.reserve("run-a", 2), /already admitted/);
  assert.equal(admission.reserve("run-b", 3).ok, true);
  assert.deepEqual(admission.snapshot(), { maxActiveTaskAttempts: 8, reserved: 8, available: 0, admittedRuns: 2 });
  assert.equal(admission.release("run-a"), true);
  assert.equal(admission.release("run-a"), false);
  assert.equal(admission.snapshot().available, 5);
  assert.throws(() => new RunAdmissionController(MAX_WORKER_TASK_ATTEMPTS + 1), RangeError);
  assert.throws(() => new RunAdmissionController(0), RangeError);
});

test("the recovered-control activity lists only accepted run-level controls for the run", async () => {
  const record = (controlId: string, action: string, state = "accepted", runId = "run-x") =>
    ({ controlId, runId, action, state, payload: {} }) as unknown as StoredControlRecordV1;
  const listed: Array<[string, number]> = [];
  const activity = createListAcceptedRunControlsActivity({
    async listAccepted(runId, limit) {
      listed.push([runId, limit]);
      return [record("a", "pause"), record("b", "approve-task"), record("c", "replay-task"), record("d", "resume", "applied"), record("e", "stop", "accepted", "run-y")];
    },
  });
  assert.deepEqual(await activity(undefined, { runId: "run-x" }), ["a", "c"]);
  assert.deepEqual(listed, [["run-x", 64]]);
});

test("the pinned Dapr SDK still has the worker slot and queue sizes P4-06 budgets for", async () => {
  const sdk = JSON.parse(await readFile(new URL("../../node_modules/@dapr/dapr/package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(sdk.version, DAPR_SDK_WORKER_LIMITS.sdkVersion, "re-measure P4-06 limits after an SDK upgrade");
  const runtime = new WorkflowRuntime({ daprHost: "127.0.0.1", daprPort: "1" });
  const worker = (runtime as unknown as { worker: { _maxConcurrentWorkItems: number; _maxQueueSize: number } }).worker;
  assert.equal(worker._maxConcurrentWorkItems, DAPR_SDK_WORKER_LIMITS.workItemSlots);
  assert.equal(worker._maxQueueSize, DAPR_SDK_WORKER_LIMITS.queueCapacity);
});

test("a controlled run races individual children so a partial wave keeps waiting", async () => {
  const runId = "run-race";
  const run = accepted({
    manifestSnapshot: {
      phases: [{ id: "P1", tasks: [{ id: "T1", ownerAgent: "a" }, { id: "T2", ownerAgent: "b" }] }],
    },
    configuration: { settings: { concurrency: 2, maxRetries: 0 }, secretRefs: {} },
  });
  const harness = mockContext();
  const workflow = runOrchestrationWorkflow(harness.context, {
    runId, submission: run, controlsEnabled: true, statusEnabled: false,
  });
  const first = (await workflow.next()).value as unknown as MockTask;
  assert.equal(first.kind, "any");
  assert.equal(first.tasks!.length, 3, "both children and the control waiter race");
  assert.equal(first.tasks![2], harness.eventTasks[0]);
  const [t1, t2] = first.tasks as Array<MockTask & { result?: unknown }>;
  t1!.isComplete = true;
  t1!.result = complete(runId, "T1", run.manifestDigest);
  const partial = (await workflow.next(t1)).value as unknown as MockTask;
  assert.equal(partial.kind, "any");
  assert.deepEqual(partial.tasks, [t2, harness.eventTasks[0]], "only the running child keeps racing");
  t2!.isComplete = true;
  t2!.result = complete(runId, "T2", run.manifestDigest);
  const terminal = await workflow.next(t2);
  assert.equal(terminal.value, harness.eventTasks[0], "a complete wave reaches the terminal control wait");
});

test("the pinned Dapr SDK WhenAllTask still does not notify a parent composite", async () => {
  // If this starts failing, the SDK fixed nested composites and the per-child race may be simplified.
  const { CompletableTask } = await import("@dapr/dapr/workflow/internal/durabletask/task/completable-task.js");
  const { WhenAllTask } = await import("@dapr/dapr/workflow/internal/durabletask/task/when-all-task.js");
  const { WhenAnyTask } = await import("@dapr/dapr/workflow/internal/durabletask/task/when-any-task.js");
  const child = new CompletableTask();
  const all = new WhenAllTask([child]);
  const any = new WhenAnyTask([all]);
  child.complete("done");
  assert.equal(all.isComplete, true);
  assert.equal(any.isComplete, false);
});

test("the pinned Dapr SDK WhenAllTask still forgets children that finished before construction", async () => {
  // If this starts failing, the SDK fixed the constructor reset and awaitWave may pass every child.
  const { CompletableTask } = await import("@dapr/dapr/workflow/internal/durabletask/task/completable-task.js");
  const { WhenAllTask } = await import("@dapr/dapr/workflow/internal/durabletask/task/when-all-task.js");
  const finished = new CompletableTask();
  finished.complete("first");
  const running = new CompletableTask();
  const all = new WhenAllTask([finished, running]);
  running.complete("second");
  assert.equal(all.isComplete, false);
});
