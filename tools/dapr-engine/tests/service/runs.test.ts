import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeManifestDigest,
  type ControlRequestV1,
  type RunStatusCreateV1,
  type RunSubmissionV1,
} from "../../contract/v1/index.ts";
import type { RunWorkflowInputV1 } from "../../orchestration/workflow.ts";
import type { StoredControlRecordV1 } from "../../storage/postgres/control-records.ts";
import type { StoredRunSubmissionV1 } from "../../storage/postgres/run-submissions.ts";
import {
  RunService,
  ServiceRunRegistry,
  createServiceRunControlEffects,
  defaultServiceHarnesses,
  leaseReleasingLifecycleWriter,
  mountedRepositoryResolver,
  snapshotAgents,
} from "../../service/runs.ts";
import { manifestTask } from "../support/execution-fixture.ts";

function submission(overrides: Partial<RunSubmissionV1> = {}): RunSubmissionV1 {
  const manifestSnapshot = {
    version: "1.0",
    phases: [{ id: "phase-1", tasks: [manifestTask({ id: "T1", ownerAgent: "builder" }), manifestTask({ id: "T2", ownerAgent: "reviewer", dependencies: ["T1"] })] }],
    agents: [{ name: "builder", description: "Builds", path: "agents/builder.md", expertise: ["ts"], collaboration: [], constraints: [], rawBody: "Build." }],
  } as unknown as RunSubmissionV1["manifestSnapshot"];
  return {
    schemaVersion: 1,
    submissionKey: "key-1",
    repositoryId: "demo",
    targetRef: "refs/heads/forge/main",
    manifestSnapshot,
    manifestDigest: computeManifestDigest(manifestSnapshot),
    selection: { mode: "auto", requestedTaskIds: [] },
    harness: { id: "stub", adapterVersion: "1" },
    configuration: { settings: { concurrency: 1 }, secretRefs: {} },
    workflowDefinitionVersion: "p5-03@1",
    ...overrides,
  };
}

function harness() {
  const stored = new Map<string, StoredRunSubmissionV1>();
  const created: RunStatusCreateV1[] = [];
  const scheduled: { instanceId: string; input: RunWorkflowInputV1 }[] = [];
  const controls: ControlRequestV1[] = [];
  let counter = 0;
  const service = new RunService({
    submissions: {
      async create(input) {
        const existing = [...stored.values()].find((record) => record.submissionKey === input.submission.submissionKey);
        if (existing) {
          return existing.snapshotDigest === input.snapshotDigest
            ? { ok: true, record: existing, reused: true }
            : { ok: false, code: "submission-conflict" };
        }
        const record = { ...input, submissionKey: input.submission.submissionKey, repositoryId: input.submission.repositoryId, createdAt: new Date(0).toISOString() };
        stored.set(input.runId, record);
        return { ok: true, record, reused: false };
      },
      async get(runId) { return stored.get(runId); },
      async list(limit) { return [...stored.values()].slice(0, limit); },
    },
    status: {
      async createRun(input) { created.push(input); },
      async getRunStatus() { return undefined; },
      async listEvents() { return { events: [], cursor: 0, hasMore: false }; },
    },
    registry: new ServiceRunRegistry(defaultServiceHarnesses()),
    repositoryRoot: (id) => id === "demo" ? "/repositories/demo" : undefined,
    checkedOutBranch: () => "refs/heads/main",
    scheduleRun: async (instanceId, input) => { scheduled.push({ instanceId, input }); },
    runControls: {
      async request(request) {
        controls.push(request);
        return { ok: true, reused: false, record: { ...request, state: "accepted", requestDigest: "sha256:0", recordVersion: 1, history: ["requested", "accepted"] } as unknown as StoredControlRecordV1 };
      },
    },
    approvals: {
      async approve(request) {
        controls.push(request);
        return { ok: true, reused: false, record: { ...request, state: "accepted" } as unknown as StoredControlRecordV1 };
      },
    },
    approvalContext: async (runId, taskId) => taskId === "T1"
      ? { runId, taskId, manifestDigest: "sha256:0" as never, logicalAttempt: 1, taskWorkflowInstanceId: "w", taskStatus: "waiting-for-approval", evidenceDigests: [] }
      : undefined,
    newRunId: () => `run_${(++counter).toString(16).padStart(32, "0")}`,
  });
  return { service, stored, created, scheduled, controls };
}

test("service submission freezes the selection, binds the run, and schedules it with controls", async () => {
  const { service, created, scheduled } = harness();
  const result = await service.submit(submission());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.status, 201);
  const runId = `run_${"1".padStart(32, "0")}`;
  assert.deepEqual(created[0]?.taskIds, ["T1", "T2"]);
  assert.equal(scheduled.length, 1);
  assert.match(scheduled[0]!.instanceId, /^forge-run-/);
  assert.equal(scheduled[0]!.input.controlsEnabled, true);
  assert.equal(scheduled[0]!.input.statusEnabled, true);
  assert.deepEqual(scheduled[0]!.input.submission.selection.effectiveTaskIds, ["T1", "T2"]);
  assert.equal(scheduled[0]!.input.runId, runId);
});

test("service submission is idempotent per key and rejects a changed snapshot", async () => {
  const { service } = harness();
  const first = await service.submit(submission());
  const again = await service.submit(submission());
  assert.ok(first.ok && again.ok);
  assert.equal(again.status, 200);
  assert.equal((again.body as { runId: string }).runId, (first.body as { runId: string }).runId);
  const changed = await service.submit(submission({ configuration: { settings: { concurrency: 2 }, secretRefs: {} } }));
  assert.deepEqual(changed.ok ? undefined : [changed.status, changed.code], [409, "submission-conflict"]);
});

test("service submission rejects unavailable harnesses, repositories, unsafe refs, and secrets", async () => {
  const { service, scheduled } = harness();
  const cases: [Partial<RunSubmissionV1>, string][] = [
    [{ harness: { id: "copilot", adapterVersion: "1" } }, "harness-unavailable"],
    [{ repositoryId: "other" }, "repository-unavailable"],
    [{ repositoryId: "../etc" }, "invalid-submission"],
    [{ targetRef: "refs/heads/main" }, "target-ref-checked-out"],
    [{ targetRef: "refs/tags/v1" }, "invalid-submission"],
    [{ targetRef: "refs/heads/a/../b" }, "invalid-submission"],
    [{ configuration: { settings: { apiToken: "x" }, secretRefs: {} } }, "secret-value-in-snapshot"],
    [{ manifestDigest: `sha256:${"0".repeat(64)}` }, "manifest-digest-mismatch"],
    [{ configuration: { settings: { concurrency: 99 }, secretRefs: {} } }, "invalid-submission"],
  ];
  for (const [overrides, code] of cases) {
    const result = await service.submit(submission(overrides));
    assert.equal(result.ok ? "accepted" : result.code, code, JSON.stringify(overrides));
  }
  assert.equal(scheduled.length, 0);
});

test("service recovery rebinds and reschedules stored runs", async () => {
  const first = harness();
  await first.service.submit(submission());
  const registry = new ServiceRunRegistry(defaultServiceHarnesses());
  const record = [...first.stored.values()][0]!;
  assert.equal(registry.get(record.runId), undefined);
  registry.bind(record.runId, record.submission);
  assert.equal(registry.get(record.runId)?.tasks.size, 2);
  assert.equal(await first.service.recover(() => assert.fail("recovery must not fail")), 1);
  assert.equal(first.scheduled.length, 2);
});

test("service controls map the local operator to run and approval coordinators", async () => {
  const { service, controls } = harness();
  const submitted = await service.submit(submission());
  assert.ok(submitted.ok);
  const runId = (submitted.body as { runId: string }).runId;
  const pause = await service.control(runId, { action: "pause" });
  assert.equal(pause.ok && pause.status, 202);
  assert.equal(controls[0]?.action, "pause");

  const approve = await service.control(runId, { action: "approve-task", payload: { taskId: "T1" } });
  assert.equal(approve.ok, true);
  assert.deepEqual(controls[1]?.payload, { taskId: "T1", evidenceDigests: [] });

  const notWaiting = await service.control(runId, { action: "approve-task", payload: { taskId: "T2" } });
  assert.equal(notWaiting.ok ? "" : notWaiting.code, "invalid-transition");
  const badAction = await service.control(runId, { action: "select-tasks" });
  assert.equal(badAction.ok ? "" : badAction.code, "invalid-control");
  const replay = await service.control(runId, { action: "replay-task", payload: {} });
  assert.equal(replay.ok ? "" : replay.code, "invalid-control");
  const unknown = await service.control(`run_${"f".repeat(32)}`, { action: "pause" });
  assert.equal(unknown.ok ? 0 : unknown.status, 404);
});

test("snapshot agents bind owners and fall back to a neutral descriptor", () => {
  const accepted = { ...submission(), selection: { mode: "auto" as const, requestedTaskIds: [], effectiveTaskIds: ["T1", "T2"] } };
  assert.equal(snapshotAgents(accepted).get("builder")?.rawBody, "Build.");
  const run = new ServiceRunRegistry(defaultServiceHarnesses()).bind("run_x", accepted);
  assert.equal(run.agentFor(run.tasks.get("T1")!).name, "builder");
  assert.equal(run.agentFor(run.tasks.get("T2")!).rawBody, "");
  assert.equal(run.agentFor(run.tasks.get("T2")!).name, "reviewer");
  assert.throws(() => new ServiceRunRegistry(new Map()).bind("run_y", accepted), /not available/);
});

test("mounted repositories require a real .git directory and a safe ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forge-repos-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "demo", ".git"), { recursive: true });
  await mkdir(join(root, "worktree"), { recursive: true });
  await writeFile(join(root, "worktree", ".git"), "gitdir: /elsewhere\n");
  const resolve = mountedRepositoryResolver(root);
  assert.equal(resolve("demo"), join(root, "demo"));
  assert.equal(resolve("worktree"), undefined);
  assert.equal(resolve("missing"), undefined);
  assert.equal(resolve("../demo"), undefined);
});

test("cancel effects request cancellation until every owned process is gone", async () => {
  const active = [{ runId: "run_a", taskId: "T1", logicalAttempt: 1, operationId: "op" }];
  const cancelled: string[] = [];
  let polls = 0;
  const effects = createServiceRunControlEffects({
    executions: {
      async listActive() { return ++polls > 2 ? [] : active; },
      async requestCancel(key, reason) { cancelled.push(`${key.taskId}:${reason}`); },
      async fenceLostExecutions() { return []; },
    },
    replays: { allocateReplayAttempt: async () => 2 },
    pollMs: 1,
  });
  const record = { controlId: randomUUID(), runId: "run_a", action: "cancel", payload: {} } as unknown as StoredControlRecordV1;
  await effects.cancel(record);
  assert.equal(cancelled.length, 2);
  assert.match(cancelled[0]!, /^T1:Run cancelled by control/);

  const stuck = createServiceRunControlEffects({
    executions: { listActive: async () => active, requestCancel: async () => undefined, fenceLostExecutions: async () => [] },
    replays: { allocateReplayAttempt: async () => 2 },
    pollMs: 1,
    cancelTimeoutMs: 5,
  });
  await assert.rejects(stuck.cancel(record), /still waiting/);
});

test("replay effects allocate through the durable store per control", async () => {
  const calls: string[] = [];
  const effects = createServiceRunControlEffects({
    executions: { listActive: async () => [], requestCancel: async () => undefined, fenceLostExecutions: async () => [] },
    replays: { allocateReplayAttempt: async (controlId, runId, taskId) => { calls.push(`${controlId}/${runId}/${taskId}`); return 3; } },
  });
  const controlId = randomUUID();
  assert.equal(await effects.replayTask({ controlId, runId: "run_a", payload: { taskId: "T1" } } as unknown as StoredControlRecordV1), 3);
  assert.deepEqual(calls, [`${controlId}/run_a/T1`]);
  await assert.rejects(effects.replayTask({ controlId, runId: "run_a", payload: {} } as unknown as StoredControlRecordV1), /taskId/);
});

test("terminal lifecycle events release repository leases without failing the event", async () => {
  const released: string[] = [];
  const errors: string[] = [];
  let failRelease = false;
  const writer = leaseReleasingLifecycleWriter(
    { appendEvent: async (input) => ({ event: { ...input, sequence: 1 } as never, reused: false }) },
    async (runId) => {
      if (failRelease) throw new Error("db down");
      released.push(runId);
    },
    (runId, error) => errors.push(`${runId}:${(error as Error).message}`),
  );
  const event = (runStatus?: string) => ({
    schemaVersion: 1, runId: "run_x", eventKey: `k-${runStatus}`, eventType: "run.started", ...(runStatus ? { runStatus } : {}),
  }) as never;
  for (const runStatus of [undefined, "running", "paused", "complete", "failed", "cancelled"]) {
    await writer.appendEvent(event(runStatus));
  }
  assert.deepEqual(released, ["run_x", "run_x", "run_x"]);
  failRelease = true;
  assert.equal((await writer.appendEvent(event("complete"))).reused, false);
  assert.deepEqual(errors, ["run_x:db down"]);
});
