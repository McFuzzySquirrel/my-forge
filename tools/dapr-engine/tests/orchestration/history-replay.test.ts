import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WorkflowContext from "@dapr/dapr/workflow/runtime/WorkflowContext.js";
import {
  runOrchestrationWorkflow,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  TASK_ATTEMPT_WORKFLOW_NAME,
  taskAttemptWorkflow,
} from "../../orchestration/index.ts";

/*
 * P6-03: replays workflow histories recorded by a live installation against
 * the current workflow code. A change that alters the sequence of scheduled
 * activities, timers, child workflows, or awaited events makes the SDK raise
 * a non-determinism failure here, before it can strand in-flight runs after
 * an upgrade. Refresh fixtures with
 * `npm run qualify -- capture-histories <project> <dir>` in
 * tools/runtime-qualification.
 */
const require = createRequire(import.meta.url);
const durable = "@dapr/dapr/workflow/internal/durabletask";
const pb = require(`${durable}/proto/orchestrator_service_pb`);
const { Registry } = require(`${durable}/worker/registry`);
const { OrchestrationExecutor } = require(`${durable}/worker/orchestration-executor`);
const Context = (WorkflowContext as unknown as { default?: unknown }).default ?? WorkflowContext;

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "histories");

function registry() {
  const value = new Registry();
  for (const [name, workflow] of [
    [RUN_ORCHESTRATION_WORKFLOW_NAME, runOrchestrationWorkflow],
    [TASK_ATTEMPT_WORKFLOW_NAME, taskAttemptWorkflow],
  ] as const) {
    // Mirrors WorkflowRuntime.registerWorkflowWithName.
    value.addNamedOrchestrator(name, (ctx: unknown, input: unknown) =>
      (workflow as (context: unknown, input: unknown) => unknown)(new (Context as new (ctx: unknown) => unknown)(ctx), input));
  }
  return value;
}

function lastOrchestratorStart(events: readonly any[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].hasOrchestratorstarted()) return index;
  return -1;
}

const files = readdirSync(fixtures).filter((file) => file.endsWith(".json")).sort();

test("recorded history fixtures cover both workflows, timers, events, and failures", () => {
  const all = files.map((file) => JSON.parse(readFileSync(path.join(fixtures, file), "utf8")) as { workflow: string; features: string[] });
  assert.ok(all.some((history) => history.workflow === RUN_ORCHESTRATION_WORKFLOW_NAME));
  assert.ok(all.some((history) => history.workflow === TASK_ATTEMPT_WORKFLOW_NAME));
  for (const feature of ["timer", "event:task-control", "event:run-control", "activity-failed"]) {
    assert.ok(all.some((history) => history.features.includes(feature)), feature);
  }
});

for (const file of files) {
  test(`recorded history replays deterministically: ${file}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(fixtures, file), "utf8")) as { instanceId: string; events: string[] };
    const events = fixture.events.map((encoded) => pb.HistoryEvent.deserializeBinary(Buffer.from(encoded, "base64")));
    const completed = events.find((event: any) => event.hasExecutioncompleted());
    assert.ok(completed, "fixture must be a terminal history");
    const replayable = events.filter((event: any) => !event.hasExecutioncompleted());
    const lastStart = lastOrchestratorStart(replayable);
    const result = await new OrchestrationExecutor(registry()).execute(
      fixture.instanceId,
      replayable.slice(0, lastStart),
      replayable.slice(lastStart),
    );
    const completion = result.actions.find((action: any) => action.hasCompleteorchestration())?.getCompleteorchestration();
    assert.ok(completion, "replay must reach the recorded completion");
    const failure = completion.getFailuredetails();
    const recorded = completed.getExecutioncompleted();
    assert.equal(
      completion.getOrchestrationstatus(),
      recorded.getOrchestrationstatus(),
      failure ? `${failure.getErrortype()}: ${failure.getErrormessage()}` : "status mismatch",
    );
    assert.equal(completion.getResult()?.getValue(), recorded.getResult()?.getValue());
  });
}

test("history replay detects a workflow change that reorders scheduled work", async () => {
  const fixture = JSON.parse(readFileSync(path.join(fixtures, files.find((file) => file.startsWith(TASK_ATTEMPT_WORKFLOW_NAME))!), "utf8")) as { instanceId: string; events: string[] };
  const events = fixture.events
    .map((encoded) => pb.HistoryEvent.deserializeBinary(Buffer.from(encoded, "base64")))
    .filter((event: any) => !event.hasExecutioncompleted());
  const changed = new Registry();
  changed.addNamedOrchestrator(TASK_ATTEMPT_WORKFLOW_NAME, async function* (ctx: unknown, input: unknown) {
    const context = new (Context as new (ctx: unknown) => { callActivity(name: string, input: unknown): unknown })(ctx);
    yield context.callActivity("newlyInsertedActivity", {});
    return yield* (taskAttemptWorkflow as (context: unknown, input: unknown) => AsyncGenerator<unknown, unknown, unknown>)(context, input);
  });
  const lastStart = lastOrchestratorStart(events);
  const result = await new OrchestrationExecutor(changed).execute(fixture.instanceId, events.slice(0, lastStart), events.slice(lastStart));
  const completion = result.actions.find((action: any) => action.hasCompleteorchestration())?.getCompleteorchestration();
  assert.ok(completion?.getFailuredetails(), "a reordered workflow must fail replay");
  assert.match(completion.getFailuredetails().getErrortype(), /NonDeterminism/);
});
