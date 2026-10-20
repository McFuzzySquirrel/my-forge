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
    [RUN]: { runId: RUN, status: "running", repositoryId: "demo", targetRef: "refs/heads/forge/main", tasks: [{ taskId: "T2", status: "waiting-for-approval" }] },
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
  return { server, post };
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
