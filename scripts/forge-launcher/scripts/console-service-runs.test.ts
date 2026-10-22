import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ServiceRunsDeps } from "./console/service-runs.ts";
import { ServiceApiError } from "./service-client.ts";
import { signedFetch, startSignedConsoleServer } from "./console-test-session.ts";

const RUN = "run_0123456789abcdef";
const OTHER = "run_fedcba9876543210";

function fakeService(options: { registered?: boolean; unreachable?: boolean } = {}) {
  const controls: unknown[][] = [];
  const runs: Record<string, Record<string, unknown>> = {
    [RUN]: {
      runId: RUN,
      status: "running",
      repositoryId: "demo",
      targetRef: "refs/heads/forge/main",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:02:00.000Z",
      tasks: [{
        taskId: "T2",
        status: "waiting-for-approval",
        logicalAttempt: 2,
        updatedAt: "2026-10-22T00:02:00.000Z",
        attempts: [{ logicalAttempt: 1, observedAt: "2026-10-22T00:01:00.000Z" }],
      }],
    },
    [OTHER]: { runId: OTHER, status: "running", repositoryId: "elsewhere", targetRef: "refs/heads/forge/main" },
  };
  const deps: ServiceRunsDeps = {
    async repositoryId() { return options.registered === false ? undefined : "demo"; },
    async client() {
      if (options.unreachable) {
        throw new ServiceApiError(0, "service-unreachable", "The local execution service is not reachable.");
      }
      return {
        list: async (repositoryId?: string) => ({ runs: Object.values(runs).filter((run) => run.repositoryId === repositoryId) }),
        get: async (runId: string) => {
          if (!runs[runId]) throw new ServiceApiError(404, "unknown-run", "missing");
          return runs[runId]!;
        },
        events: async (_runId: string, after: number) => ({
          events: after < 2 ? [{ sequence: 2, eventType: "task.waiting-for-approval", taskId: "T2" }] : [],
          cursor: 2,
          hasMore: false,
        }),
        control: async (runId: string, action: string, payload: Record<string, unknown> = {}) => {
          controls.push([runId, action, payload]);
          if (action === "resume") throw new ServiceApiError(409, "invalid-run-state", "Run is not paused.");
          return { action, controlId: "c-1", state: "applied" };
        },
      } as unknown as Awaited<ReturnType<ServiceRunsDeps["client"]>>;
    },
  };
  return { deps, controls };
}

async function withConsole(
  t: { after(fn: () => unknown): void },
  serviceRuns: ServiceRunsDeps,
  port: number,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-console-service-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-console-service-repo-"));
  const previousHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  const server = await startSignedConsoleServer({ repoRoot: repo, port, open: false, onLog: () => {}, serviceRuns });
  t.after(async () => {
    await server.stop();
    if (previousHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const post = (route: string, body: unknown, token = server.token) => signedFetch(`${server.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forge-token": token },
    body: JSON.stringify(body),
  });
  return { server, post, repo };
}

test("the Console lists, monitors, and controls the current repository's service runs", async (t) => {
  const { deps, controls } = fakeService();
  const { server, post } = await withConsole(t, deps, 44970);

  const list = await (await signedFetch(`${server.url}/api/service/runs`)).json() as { available: boolean; runs: { runId: string }[] };
  assert.equal(list.available, true);
  assert.deepEqual(list.runs.map((run) => run.runId), [RUN]);

  const detail = await (await signedFetch(`${server.url}/api/service/run?id=${RUN}&after=0`)).json() as { run: { status: string }; events: unknown[]; cursor: number };
  assert.equal(detail.run.status, "running");
  assert.equal(detail.events.length, 1);
  assert.equal(detail.cursor, 2);
  const resumed = await (await signedFetch(`${server.url}/api/service/run?id=${RUN}&after=2`)).json() as { events: unknown[] };
  assert.equal(resumed.events.length, 0);

  const approved = await post("/api/service/control", { runId: RUN, action: "approve-task", taskId: "T2" });
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), { ok: true, action: "approve-task", controlId: "c-1", state: "applied" });
  const rejected = await post("/api/service/control", { runId: RUN, action: "resume" });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json() as { code: string }).code, "invalid-run-state");
  assert.deepEqual(controls, [[RUN, "approve-task", { taskId: "T2" }], [RUN, "resume", {}]]);
});

test("Console overview status comes from the current Dapr run, not archived workflow state", async (t) => {
  const { deps } = fakeService();
  const { server, repo } = await withConsole(t, deps, 44977);
  const docs = path.join(repo, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "EXECUTION-MANIFEST.json"), JSON.stringify({
    version: 1,
    phases: [{ id: "phase-1", title: "Phase 1", tasks: [{
      id: "T2", title: "Review", description: "Review the result.", dependencies: [],
      expectedOutputs: [], validationCommands: [],
    }] }],
  }));
  fs.writeFileSync(path.join(docs, "WORKFLOW-STATE.json"), JSON.stringify({
    runId: "run_legacy",
    status: "complete",
    tasks: { T2: { taskId: "T2", status: "complete", attempt: 1, outputFiles: [] } },
  }));

  const summary = await (await signedFetch(`${server.url}/api/summary`)).json() as {
    run: { runId: string; status: string; counts: { running: number } };
  };
  assert.equal(summary.run.runId, RUN);
  assert.equal(summary.run.status, "running");
  assert.equal(summary.run.counts.running, 1);

  const tasks = await (await signedFetch(`${server.url}/api/tasks`)).json() as { id: string; status: string; attempt: number; startedAt: string | null }[];
  assert.deepEqual(tasks.map(({ id, status, attempt, startedAt }) => [id, status, attempt, startedAt]), [
    ["T2", "waiting-for-approval", 2, "2026-10-22T00:01:00.000Z"],
  ]);
  const actions = await (await signedFetch(`${server.url}/api/actions`)).json() as { canPause: boolean; canStop: boolean };
  assert.equal(actions.canPause, true);
  assert.equal(actions.canStop, true);
});

test("service controls are scoped to the current repository and validated", async (t) => {
  const { deps, controls } = fakeService();
  const { server, post } = await withConsole(t, deps, 44971);

  assert.equal((await signedFetch(`${server.url}/api/service/run?id=${OTHER}`)).status, 404);
  assert.equal((await post("/api/service/control", { runId: OTHER, action: "pause" })).status, 404);
  assert.equal((await post("/api/service/control", { runId: RUN, action: "explode" })).status, 400);
  assert.equal((await post("/api/service/control", { runId: RUN, action: "approve-task" })).status, 400);
  assert.equal((await post("/api/service/control", { runId: "../etc", action: "pause" })).status, 400);
  assert.equal((await post("/api/service/control", { runId: RUN, action: "pause" }, "wrong")).status, 403);
  const unsigned = await fetch(`${server.url}/api/service/runs`);
  assert.equal(unsigned.status, 401);
  assert.deepEqual(controls, []);
});

test("the Console explains an unregistered repository or an unavailable service", async (t) => {
  const unregistered = await withConsole(t, fakeService({ registered: false }).deps, 44972);
  const list = await (await signedFetch(`${unregistered.server.url}/api/service/runs`)).json() as { available: boolean; reason: string; message: string };
  assert.equal(list.available, false);
  assert.equal(list.reason, "not-registered");
  assert.match(list.message, /runtime repo add/);
  assert.equal((await unregistered.post("/api/service/control", { runId: RUN, action: "pause" })).status, 409);

  const down = await withConsole(t, fakeService({ unreachable: true }).deps, 44973);
  const downList = await (await signedFetch(`${down.server.url}/api/service/runs`)).json() as { available: boolean; reason: string; message: string };
  assert.equal(downList.available, false);
  assert.equal(downList.reason, "unavailable");
  assert.match(downList.message, /not reachable/);
  assert.equal((await signedFetch(`${down.server.url}/api/service/run?id=${RUN}`)).status, 503);
});

test("Console build controls route to the service run for a registered repository", async (t) => {
  const { deps, controls } = fakeService();
  const { post, repo } = await withConsole(t, deps, 44974);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "EXECUTION-MANIFEST.json"), JSON.stringify({
    version: 1,
    phases: [{ id: "phase-1", name: "Phase 1", tasks: [{
      id: "T2",
      title: "Review the build",
      description: "Review the build.",
      dependencies: [],
      expectedOutputs: [],
      validationCommands: [],
      contract: {
        version: 1,
        kind: "human-review",
        requirements: ["Review the build."],
        acceptanceCriteria: ["The reviewer approves."],
        constraints: [],
        references: ["README.md"],
        reviewFile: "docs/review.json",
      },
    }] }],
  }));

  const paused = await post("/api/control", { action: "pause" });
  assert.equal(paused.status, 200);
  assert.match((await paused.json() as { message: string }).message, /Pause requested for service run run_0123456789abcdef/);
  assert.equal((await post("/api/control", { action: "stop" })).status, 200);
  assert.equal((await post("/api/control", { action: "replay", taskId: "T1" })).status, 200);
  assert.equal((await post("/api/control", { action: "replay" })).status, 400);

  const tooShort = await post("/api/tasks/human-review", { taskId: "T2", reviewer: "me", notes: "looks good" });
  assert.equal(tooShort.status, 400);
  const notes = "Exercised the primary journey end to end and found no defects.";
  const approved = await post("/api/tasks/human-review", { taskId: "T2", reviewer: "me", notes });
  assert.equal(approved.status, 200);
  const body = await approved.json() as { ok: boolean; resumed: boolean; message: string; reviewRecord: string };
  assert.equal(body.ok, true);
  assert.equal(body.resumed, false);
  assert.match(body.message, /T2 approved for service run/);
  assert.equal(body.reviewRecord, "docs/reviews/T2-console-review.md", body.message);
  const record = fs.readFileSync(path.join(repo, body.reviewRecord), "utf8");
  assert.match(record, /Reviewer: me/);
  assert.ok(record.includes(notes));
  assert.match(record, /Run: run_0123456789abcdef\nControl: c-1/);
  assert.ok(!fs.existsSync(path.join(repo, "docs", "review.json")), "the service path writes no legacy attestation");
  assert.deepEqual(controls, [
    [RUN, "pause", {}],
    [RUN, "stop", {}],
    [RUN, "replay-task", { taskId: "T1" }],
    [RUN, "approve-task", { taskId: "T2" }],
  ]);
});

test("Console build controls fail closed for unregistered repositories", async (t) => {
  const { deps, controls } = fakeService({ registered: false });
  const { post, repo } = await withConsole(t, deps, 44975);
  const paused = await post("/api/control", { action: "pause" });
  assert.equal(paused.status, 409);
  assert.match((await paused.json() as { message: string }).message, /runtime repo add.*Legacy controls are retired/);
  assert.equal(fs.existsSync(path.join(repo, "docs", "engine-control.json")), false);
  assert.equal((await post("/api/control", { action: "run" })).status, 409);
  assert.equal((await post("/api/control", { action: "resume" })).status, 409);
  assert.equal((await post("/api/tasks/human-review", {
    taskId: "T2", reviewer: "me", notes: "This is sufficiently long review evidence for the negative control test.",
  })).status, 409);
  assert.deepEqual(controls, []);

  const down = await withConsole(t, fakeService({ unreachable: true }).deps, 44976);
  const unavailable = await down.post("/api/control", { action: "stop" });
  assert.equal(unavailable.status, 503);
});
