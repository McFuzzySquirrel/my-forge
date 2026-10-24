import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { get as httpGet, request as httpRequest } from "node:http";

import type { ConsoleServer } from "./console/server.ts";
import { sessionHeaders, signedFetch, startSignedConsoleServer as startConsoleServer } from "./console-test-session.ts";
import type { RuntimeAdminState, RunnerReadiness } from "./console/types.ts";
import type { SpawnOptions } from "./console/control.ts";
import { writeFeatureFixture } from "./feature-fixture.ts";
import { featureIncrementHandoffHasChange, recordFeatureIncrementHandoff } from "./authoring-state.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let portCounter = 0;
function nextPort(): number {
  return 44123 + (portCounter++ % 50);
}

function moveFixtureToGithub(repo: string): void {
  renameSync(join(repo, ".agents"), join(repo, ".github"));
  const file = join(repo, "docs", "EXECUTION-MANIFEST.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.harnessRoot = ".github";
  writeFileSync(file, JSON.stringify(manifest));
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-console-"));
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".agents", "skills", "add-endpoint"), { recursive: true });
  mkdirSync(join(root, ".agents", "agents"), { recursive: true });

  writeFileSync(join(docs, "IDEA.md"), "# Idea\n\nBuild a thing.\n", "utf8");
  writeFeatureFixture(root);

  const manifest = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    repoRoot: root,
    harnessRoot: ".agents",
    sourceLayout: "features",
    prdPath: join(docs, "PRD.md"),
    progressPath: join(docs, "PROGRESS.md"),
    auditPath: join(docs, "EXECUTION-AUDIT.jsonl"),
    validationCommands: [],
    approvalGates: { preflight: true, betweenPhases: true },
    phases: [
      {
        id: "1",
        title: "Foundation",
        description: "",
        ownerAgents: ["qa-engineer"],
        dependencies: [],
        approvalRequired: false,
        tasks: [
          { id: "1.1", title: "Scaffold", description: "Set up project", ownerAgent: "qa-engineer", dependencies: [], expectedOutputs: ["src/index.ts"], validationCommands: [], approvalRequired: false, produces: "work.1.1" },
          { id: "1.2", title: "Build", description: "Implement", ownerAgent: "qa-engineer", dependencies: ["1.1"], inputs: ["work.1.1"], expectedOutputs: [], validationCommands: [], approvalRequired: false },
        ],
      },
    ],
    warnings: [],
  };
  writeFileSync(join(docs, "EXECUTION-MANIFEST.json"), JSON.stringify(manifest), "utf8");

  const state = {
    runId: "run-1",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    manifestPath: join(docs, "EXECUTION-MANIFEST.json"),
    manifestVersion: "1.0",
    harness: "opencode",
    status: "running",
    currentPhase: "1",
    tasks: {
      "1.1": {
        taskId: "1.1",
        status: "complete",
        ownerAgent: "qa-engineer",
        attempt: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:02:00.000Z",
        outputFiles: ["src/index.ts"],
        artifactId: "solution-001",
      },
      "1.2": {
        taskId: "1.2",
        status: "running",
        ownerAgent: "qa-engineer",
        attempt: 1,
        startedAt: "2026-01-01T00:03:00.000Z",
        outputFiles: [],
      },
    },
    blockers: ["waiting for review"],
  };
  writeFileSync(join(docs, "WORKFLOW-STATE.json"), JSON.stringify(state), "utf8");
  writeFileSync(join(docs, "EXECUTION-AUDIT.jsonl"), "", "utf8");
  writeFileSync(join(docs, "forge.log"), "line one\nline two\n", "utf8");
  writeFileSync(join(docs, "AUTHORING-EVENTS.jsonl"), "", "utf8");

  mkdirSync(join(docs, "artifacts", "solution"), { recursive: true });
  writeFileSync(
    join(docs, "artifacts", "solution", "solution-001.json"),
    JSON.stringify({
      artifactId: "solution-001",
      type: "solution.architecture",
      category: "work",
      taskId: "1.1",
      producedBy: "qa-engineer",
      status: "complete",
      summary: "Architecture decided",
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      filesChanged: ["src/index.ts"],
      inputs: [],
      payload: { decision: "use express" },
      nextActions: [],
    }),
    "utf8",
  );

  writeFileSync(
    join(root, ".agents", "agents", "qa-engineer.md"),
    "---\nname: qa-engineer\ndescription: >\n  Owns test quality and\n  keeps the build green.\nmodel: gpt-4o\n---\n\n## Expertise\n- Testing\n",
    "utf8",
  );

  writeFileSync(
    join(root, ".agents", "skills", "add-endpoint", "SKILL.md"),
    "---\nname: add-endpoint\ndescription: >\n  Adds a REST endpoint following\n  project conventions.\n---\n\n# Skill: Add Endpoint\n",
    "utf8",
  );

  return root;
}

interface FakeSpawn {
  calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }>;
  pids: number[];
}

function fakeSpawner(): FakeSpawn {
  const state: FakeSpawn = { calls: [], pids: [] };
  return state;
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    httpGet(url, { agent: false, headers: sessionHeaders(url) }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on("error", reject);
  });
}

function getText(url: string): Promise<{ status: number; body: string; type: string | null }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { agent: false, headers: sessionHeaders(url) }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, type: res.headers["content-type"] ?? null }));
    }).on("error", reject);
  });
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(url, { agent: false, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...sessionHeaders(url), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch { resolve({ status: res.statusCode ?? 0, body: text }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function collectSse(url: string) {
  const events: Array<{ type: string; data: unknown }> = [];
  const req = httpRequest(url, { agent: false, headers: sessionHeaders(url) }, (res) => {
    let buffer = "";
    let eventType = "message";
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) events.push({ type: eventType, data: JSON.parse(data) });
        eventType = "message";
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return events;
}

async function withServer<T>(
  fn: (server: ConsoleServer, repo: string, spawned: FakeSpawn) => Promise<T>,
  opts: {
    repoRoot?: boolean;
    registered?: boolean;
    runner?: RunnerReadiness | null | (() => RunnerReadiness | null);
  } = { repoRoot: true },
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "forge-home-"));
  const prevHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;

  const repo = makeRepo();
  const spawn = fakeSpawner();
  const server = await startConsoleServer({
    repoRoot: opts.repoRoot ? repo : undefined,
    port: nextPort(),
    open: false,
    onLog: () => {},
    clientDir: join(repo, "docs"),
    ...(opts.registered ? {
      serviceRuns: {
        repositoryId: async () => "test-repository",
        client: async () => { throw new Error("service client is not needed in this test"); },
      },
    } : {}),
    ...(opts.runner !== undefined ? {
      runnerReadiness: async () => typeof opts.runner === "function" ? opts.runner() : opts.runner ?? null,
    } : {}),
    deps: {
      spawner: (cmd, args, o) => { spawn.calls.push({ cmd, args, opts: o }); return { pid: 9000 + spawn.calls.length }; },
      isPidAlive: () => false,
    },
  });
  try {
    return await fn(server, repo, spawn);
  } finally {
    await server.stop();
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  }
}

test("summary detects newly authored canonical requirements for team generation", async () => {
  await withServer(async (server, repo) => {
    renameSync(join(repo, ".agents", "agents"), join(repo, ".agents", "agents-backup"));
    const prd = join(repo, "docs", "PRD.md");
    renameSync(prd, `${prd}.bak`);

    const before = await getJson(`${server.url}/api/summary`) as { hasPrd: boolean; hasTeam: boolean };
    assert.equal(before.hasPrd, false);
    assert.equal(before.hasTeam, false);

    renameSync(`${prd}.bak`, prd);
    const after = await getJson(`${server.url}/api/summary`) as { hasPrd: boolean; hasVision: boolean; hasTeam: boolean };
    assert.equal(after.hasPrd, true);
    assert.equal(after.hasVision, true);
    assert.equal(after.hasTeam, false);

    const docs = await getJson(`${server.url}/api/docs`) as { entries: Array<{ kind: string; relPath: string; exists: boolean }> };
    assert.ok(docs.entries.some((entry) => entry.kind === "vision" && entry.relPath === "docs/PRD.md" && entry.exists));
  });
});

test("serves summary, tasks, docs, team, and actions", async () => {
  await withServer(async (server, repo) => {
    const summary = await getJson(`${server.url}/api/summary`) as { repoName: string; hasPrd: boolean; hasTeam: boolean; defaultTimeoutMs: number; run: null };
    assert.equal(summary.repoName, basename(repo));
    assert.equal(summary.hasPrd, true);
    assert.equal(summary.hasTeam, true);
    assert.equal(summary.run, null, "legacy workflow state must not be treated as a live service run");
    assert.equal(summary.defaultTimeoutMs, 600000);

    const tasks = await getJson(`${server.url}/api/tasks`) as Array<{ id: string; status: string; phaseTitle: string; durationMs: number | null }>;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.status, "pending");
    assert.equal(tasks[0]!.phaseTitle, "Foundation");
    assert.equal(tasks[0]!.durationMs, null);
    assert.equal((await signedFetch(`${server.url}/api/state`)).status, 404);

    const docs = await getJson(`${server.url}/api/docs`) as { entries: Array<{ kind: string }> };
    assert.ok(docs.entries.some((e) => e.kind === "vision"));
    assert.ok(!docs.entries.some((e) => e.kind === "prd"));
    assert.ok(docs.entries.some((e) => e.kind === "idea"));

    const team = await getJson(`${server.url}/api/team`) as { agents: Array<{ name: string; description: string; model: string }>; skills: Array<{ name: string; description: string; category: string }> };
    assert.equal(team.agents.length, 1);
    assert.equal(team.agents[0]!.name, "qa-engineer");
    assert.equal(team.agents[0]!.description, "Owns test quality and keeps the build green.");
    assert.equal(team.agents[0]!.model, "gpt-4o");
    assert.equal(team.skills.length, 1);
    const projectSkill = team.skills.find((s) => s.name === "add-endpoint");
    assert.ok(projectSkill, "add-endpoint skill should be listed");
    assert.equal(projectSkill!.description, "Adds a REST endpoint following project conventions.");
    assert.equal(projectSkill!.category, "project");
    const actions = await getJson(`${server.url}/api/actions`) as { canRun: boolean; failedTasks: string[] };
    assert.equal(actions.canRun, true, "archived legacy running state must not block a new Dapr run");
    assert.deepEqual(actions.failedTasks, []);
  });
});

test("serves the user guide at /guide.md", async () => {
  await withServer(async (server, repo) => {
    writeFileSync(join(repo, "docs", "guide.md"), "# Forge Console user guide\n\nTest walkthrough.\n", "utf8");
    const res = await getText(`${server.url}/guide.md`);
    assert.equal(res.status, 200);
    assert.match(res.type ?? "", /text\/markdown/);
    assert.match(res.body, /Test walkthrough/);
    assert.match(res.body, /^# Forge Console user guide/m);
  });
});

test("serves logs and artifacts", async () => {
  await withServer(async (server) => {
    const logs = await getJson(`${server.url}/api/logs?lines=1`) as { lines: string[]; truncated: boolean };
    assert.deepEqual(logs.lines, ["line two"]);
    assert.equal(logs.truncated, true);

    const artifacts = await getJson(`${server.url}/api/artifacts`) as { artifacts: Array<{ artifactId: string; type: string }>; types: string[] };
    assert.equal(artifacts.artifacts.length, 1);
    assert.equal(artifacts.artifacts[0]!.artifactId, "solution-001");
    assert.deepEqual(artifacts.types, ["solution.architecture"]);
  });
});

test("serves the host-runner runtime log without a repository-scoped engine log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "forge-runtime-"));
  const previousRuntimeDir = process.env.MYFORGE_RUNTIME_DIR;
  process.env.MYFORGE_RUNTIME_DIR = runtimeDir;
  writeFileSync(join(runtimeDir, "host-runner.log"), "runtime line one\nruntime line two\n", "utf8");
  try {
    await withServer(async (server) => {
      const logs = await getJson(`${server.url}/api/logs?lines=10&source=runtime`) as { lines: string[]; truncated: boolean };
      assert.deepEqual(logs.lines, ["runtime line one", "runtime line two"]);
      assert.equal(logs.truncated, false);
      const rejected = await getJson(`${server.url}/api/logs?source=unknown`) as { message: string };
      assert.match(rejected.message, /Unknown log source/);
    });
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.MYFORGE_RUNTIME_DIR;
    else process.env.MYFORGE_RUNTIME_DIR = previousRuntimeDir;
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("streams a snapshot and audit/log events over SSE", async () => {
  await withServer(async (server, repo) => {
    const events = collectSse(`${server.url}/api/events`);
    await sleep(200);
    const snapshot = events.find((e) => e.type === "snapshot");
    assert.ok(snapshot);
    assert.equal((snapshot.data as Record<string, unknown>).state, null);

    appendFileSync(join(repo, "docs", "EXECUTION-AUDIT.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), action: "task.complete", taskId: "1.2" })}\n`, "utf8");
    appendFileSync(join(repo, "docs", "forge.log"), "new log line\n", "utf8");

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(events.some((e) => e.type === "audit") && events.some((e) => e.type === "log"))) {
      await sleep(50);
    }
    assert.ok(events.some((e) => e.type === "audit" && (e.data as { action: string }).action === "task.complete"));
    assert.ok(events.some((e) => e.type === "log"));

    appendFileSync(join(repo, "docs", "forge.log"), `FORGE_EVENT ${JSON.stringify({ type: "authoring.started", operation: "feature-increment" })}\nplain after event\n`, "utf8");
    const eventDeadline = Date.now() + 3000;
    while (Date.now() < eventDeadline && !events.some((e) => e.type === "authoring")) await sleep(50);
    assert.ok(events.some((e) => e.type === "authoring" && (e.data as { type: string }).type === "authoring.started"));
    assert.ok(events.some((e) => e.type === "log" && (e.data as { line: string }).line === "plain after event"));
  });
});

test("projects reconciliation details for Console review", async () => {
  await withServer(async (server, repo) => {
    const file = join(repo, "docs", "EXECUTION-MANIFEST.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    manifest.reconciliation = { preservedTaskIds: ["1.1"], newTaskIds: ["NEW-1.1"], removedTaskIds: ["OLD-1.1"], changedTaskIds: ["1.2"] };
    writeFileSync(file, JSON.stringify(manifest), "utf8");
    const summary = await getJson(`${server.url}/api/summary`) as { manifest: { reconciliation: { newTaskIds: string[]; changedTaskIds: string[] } } };
    assert.deepEqual(summary.manifest.reconciliation.newTaskIds, ["NEW-1.1"]);
    assert.deepEqual(summary.manifest.reconciliation.changedTaskIds, ["1.2"]);
  });
});

test("pause and stop reject unregistered repositories without writing legacy controls", async () => {
  await withServer(async (server, repo) => {
    writeFileSync(join(repo, "docs", "engine.pid"), "12345\n", "utf8");
    const token = server.token;

    const pause = await postJson(`${server.url}/api/control`, { action: "pause" }, { "X-Forge-Token": token });
    assert.equal(pause.status, 409);
    assert.equal((pause.body as { code: string }).code, "service-required");
    assert.equal(existsSync(join(repo, "docs", "engine-control.json")), false);

    const stop = await postJson(`${server.url}/api/control`, { action: "stop" }, { "X-Forge-Token": token });
    assert.equal(stop.status, 409);
    assert.equal(existsSync(join(repo, "docs", "engine-control.json")), false);
  });
});

test("control POST is rejected without the token", async () => {
  await withServer(async (server) => {
    const res = await postJson(`${server.url}/api/control`, { action: "pause" });
    assert.equal(res.status, 403);
  });
});

test("run and replay reject unregistered repositories without spawning the legacy engine", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal(run.status, 409);
    assert.equal((run.body as { code: string }).code, "service-required");

    const replay = await postJson(`${server.url}/api/control`, { action: "replay", taskId: "1.2" }, { "X-Forge-Token": token });
    assert.equal(replay.status, 409);
    assert.equal(spawned.calls.length, 0);
  });
});

test("run refuses unregistered repositories even when a GitHub harness root is selected", async () => {
  await withServer(async (server, repo, spawned) => {
    moveFixtureToGithub(repo);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": server.token });
    assert.equal(run.status, 409);
    assert.equal((run.body as { code: string }).code, "service-required");
    assert.equal(spawned.calls.length, 0);
  });
});

test("set a single task's timeout and persist it to the manifest", async () => {
  await withServer(async (server, repo) => {
    const token = server.token;
    const res = await postJson(`${server.url}/api/tasks/timeout`, { taskId: "1.2", timeoutMs: 900000 }, { "X-Forge-Token": token });
    assert.equal((res.body as { ok: boolean }).ok, true);

    const manifest = JSON.parse(readFileSync(join(repo, "docs", "EXECUTION-MANIFEST.json"), "utf8")) as { phases: Array<{ tasks: Array<{ id: string; timeoutMs?: number }> }> };
    const task = manifest.phases.flatMap((p) => p.tasks).find((t) => t.id === "1.2");
    assert.equal(task!.timeoutMs, 900000);

    const tasks = await getJson(`${server.url}/api/tasks`) as Array<{ id: string; timeoutMs: number | null }>;
    assert.equal(tasks.find((t) => t.id === "1.2")!.timeoutMs, 900000);
  });
});

test("set all task timeouts and update the engine default", async () => {
  await withServer(async (server, repo) => {
    const token = server.token;
    const res = await postJson(`${server.url}/api/tasks/timeout`, { timeoutMs: 1200000 }, { "X-Forge-Token": token });
    assert.equal((res.body as { ok: boolean }).ok, true);
    assert.equal((res.body as { affected: number }).affected, 2);

    const manifest = JSON.parse(readFileSync(join(repo, "docs", "EXECUTION-MANIFEST.json"), "utf8")) as { phases: Array<{ tasks: Array<{ timeoutMs?: number }> }> };
    for (const task of manifest.phases.flatMap((p) => p.tasks)) {
      assert.equal(task.timeoutMs, 1200000);
    }

    const config = JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")) as { taskTimeoutMs: string };
    assert.equal(config.taskTimeoutMs, "1200000");

    const summary = await getJson(`${server.url}/api/summary`) as { defaultTimeoutMs: number };
    assert.equal(summary.defaultTimeoutMs, 1200000);
  });
});

test("setting the engine default timeout persists the copilot harness on a GitHub repo", async () => {
  await withServer(async (server, repo) => {
    moveFixtureToGithub(repo);

    const res = await postJson(`${server.url}/api/tasks/timeout`, { timeoutMs: 900000 }, { "X-Forge-Token": server.token });
    assert.equal((res.body as { ok: boolean }).ok, true);

    const config = JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")) as { harness: string };
    assert.equal(config.harness, "copilot");
  });
});

test("timeout update rejects invalid values and missing token", async () => {
  await withServer(async (server) => {
    const token = server.token;

    const zero = await postJson(`${server.url}/api/tasks/timeout`, { timeoutMs: 0 }, { "X-Forge-Token": token });
    assert.equal(zero.status, 400);

    const nan = await postJson(`${server.url}/api/tasks/timeout`, { timeoutMs: "lots" }, { "X-Forge-Token": token });
    assert.equal(nan.status, 400);

    const unauth = await postJson(`${server.url}/api/tasks/timeout`, { timeoutMs: 1000 });
    assert.equal(unauth.status, 403);
  });
});

test("requirements actions are refused; team, skills, and manifest still dispatch", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const spawnedBefore = spawned.calls.length;

    // ADR-060: a requirements stage is not a background job.
    for (const action of ["draft-prd", "draft-existing-prd", "feature-prd"]) {
      const body = (await postJson(`${server.url}/api/control`, { action, prompt: "a search box" }, { "X-Forge-Token": token })).body as { ok: boolean; message: string };
      assert.equal(body.ok, false, `${action} should not report success`);
      assert.match(body.message, /interactive/i, `${action} should name the interactive path`);
    }
    assert.equal(spawned.calls.length, spawnedBefore, "requirements actions must not spawn a job");

    const team = await postJson(`${server.url}/api/control`, { action: "draft-team" }, { "X-Forge-Token": token });
    assert.equal((team.body as { ok: boolean }).ok, true);
    assert.ok((team.body as { message: string }).message.includes("team"), "message should mention team");

    renameSync(join(repo, "docs", "EXECUTION-MANIFEST.json"), join(repo, "docs", "EXECUTION-MANIFEST.json.bak"));
    const compile = await postJson(`${server.url}/api/control`, { action: "compile-manifest" }, { "X-Forge-Token": token });
    assert.equal((compile.body as { ok: boolean }).ok, true);
    assert.ok((compile.body as { message: string }).message.includes("Manifest"), "message should mention manifest");
    assert.ok(spawned.calls.at(-1)?.args.includes("compile-manifest"), "compile-manifest action should spawn the compile-manifest subcommand");
    for (const call of spawned.calls.slice(-2)) {
      assert.equal(call.opts.logFile, join(repo, "docs", "forge.log"));
    }
  });
});

test("feature-increment requires a prompt and then reports the interactive handoff", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const missing = await postJson(`${server.url}/api/control`, { action: "feature-increment" }, { "X-Forge-Token": token });
    assert.equal(missing.status, 400);

    const spawnedBefore = spawned.calls.length;
    const result = await postJson(`${server.url}/api/control`, {
      action: "feature-increment",
      prompt: "Add a search screen",
      run: true,
    }, { "X-Forge-Token": token });
    // ADR-060: the feature stage is requirements, so it cannot be one job.
    assert.equal((result.body as { ok: boolean }).ok, false);
    assert.match((result.body as { message: string }).message, /interactive/i);
    assert.equal(spawned.calls.length, spawnedBefore, "no job should be spawned");
  });
});

test("feature-increment continuation requires a changed feature after the interactive handoff", async () => {
  await withServer(async (server, repo, spawned) => {
    const spawnedBefore = spawned.calls.length;
    const premature = await postJson(`${server.url}/api/control`, {
      action: "feature-increment-continue",
    }, { "X-Forge-Token": server.token });
    assert.equal((premature.body as { ok: boolean }).ok, false);
    assert.equal(spawned.calls.length, spawnedBefore);

    recordFeatureIncrementHandoff(repo);
    writeFileSync(join(repo, "docs", "features", "new-feature.md"), "# New feature\n\nA new requirement.\n");
    assert.equal(featureIncrementHandoffHasChange(repo), true);
    const result = await postJson(`${server.url}/api/control`, {
      action: "feature-increment-continue",
    }, { "X-Forge-Token": server.token });
    assert.equal(result.status, 200);
    assert.equal((result.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)?.args.join(" ").includes("feature-increment-continue"));
  });
});

test("project list, add, and select round-trip through the registry", async () => {
  await withServer(async (server, repo) => {
    const token = server.token;
    const projects = await getJson(`${server.url}/api/projects`) as { projects: Array<{ path: string }>; current: string | null };
    assert.equal(projects.current, repo);
    assert.ok(projects.projects.some((p) => p.path === repo));

    const add = await postJson(`${server.url}/api/projects/add`, { path: repo }, { "X-Forge-Token": token });
    assert.equal((add.body as { ok: boolean }).ok, true);
  });
});

test("artifact content path traversal is rejected", async () => {
  await withServer(async (server) => {
    const res = await getJson(`${server.url}/api/artifact/content?path=..%2F..%2Fetc%2Fpasswd`);
    assert.equal(res, null);
  });
});

test("POST /api/uploads stages uploaded content to a temp file and returns its path", async () => {
  await withServer(async (server) => {
    const token = server.token;
    const res = await postJson(`${server.url}/api/uploads`, { name: "market research.md", content: "# Research\n\nSeed doc.\n" }, { "X-Forge-Token": token });
    const body = res.body as { ok: boolean; path?: string; name?: string };
    assert.equal(body.ok, true);
    assert.ok(body.path && existsSync(body.path), "staged file should exist");
    assert.equal(readFileSync(body.path!, "utf8"), "# Research\n\nSeed doc.\n");
    assert.equal(body.name, "market_research.md");
  });
});

test("createProject passes FORGE_PRD_FILE and FORGE_RESEARCH_FILES to the launcher", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const prd = join(repo, "PRD.md");
    const research = join(repo, "research.md");
    writeFileSync(prd, "# PRD\n", "utf8");
    writeFileSync(research, "# Seed\n", "utf8");

    const res = await postJson(`${server.url}/api/projects/create`, {
      name: "my-app",
      idea: "Build an app.",
      parentDir: "/tmp",
      prdPath: prd,
      researchPaths: [research],
    }, { "X-Forge-Token": token });
    assert.equal((res.body as { ok: boolean }).ok, true);

    const call = spawned.calls.at(-1);
    assert.ok(call);
    assert.equal(call.opts.env!.FORGE_PRD_FILE, prd);
    assert.equal(call.opts.env!.FORGE_RESEARCH_FILES, research);
  });
});

test("createProject rejects a missing PRD path", async () => {
  await withServer(async (server) => {
    const token = server.token;
    const res = await postJson(`${server.url}/api/projects/create`, {
      name: "my-app",
      idea: "Build an app.",
      prdPath: "/does/not/exist.md",
    }, { "X-Forge-Token": token });
    assert.equal(res.status, 400);
    assert.match((res.body as { message: string }).message, /PRD file not found/);
  });
});

test("bootstrap forwards the chosen authoring runner and rejects an unknown one", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const res = await postJson(`${server.url}/api/projects/bootstrap`, { path: repo, runner: "claude" }, { "X-Forge-Token": token });
    assert.equal((res.body as { ok: boolean }).ok, true);

    const call = spawned.calls.at(-1);
    assert.ok(call);
    assert.equal(call.args[call.args.indexOf("--runner") + 1], "claude");

    const before = spawned.calls.length;
    const bad = await postJson(`${server.url}/api/projects/bootstrap`, { path: repo, runner: "gpt" }, { "X-Forge-Token": token });
    assert.equal(bad.status, 400);
    assert.match((bad.body as { message: string }).message, /runner must be copilot, opencode, or claude/);
    assert.equal(spawned.calls.length, before);
  });
});

test("createProject rejects non-integer concurrency values", async () => {
  await withServer(async (server) => {
    const token = server.token;
    const fraction = await postJson(`${server.url}/api/projects/create`, {
      name: "my-app",
      idea: "Build an app.",
      concurrency: 2.5,
    }, { "X-Forge-Token": token });
    assert.equal(fraction.status, 400);
    assert.match((fraction.body as { message: string }).message, /positive integer/);

    const stringValue = await postJson(`${server.url}/api/projects/create`, {
      name: "my-app",
      idea: "Build an app.",
      concurrency: "3",
    }, { "X-Forge-Token": token });
    assert.equal(stringValue.status, 400);
    assert.match((stringValue.body as { message: string }).message, /positive integer/);
  });
});

test("engine-config toggles auto-commit and flows into service-run entrypoint args", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    assert.equal((await getJson(`${server.url}/api/summary`) as { autoCommit: boolean }).autoCommit, true);

    const off = await postJson(`${server.url}/api/engine-config`, { autoCommit: false }, { "X-Forge-Token": token });
    assert.equal((off.body as { ok: boolean }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")).autoCommit, false);
    assert.equal((await getJson(`${server.url}/api/summary`) as { autoCommit: boolean }).autoCommit, false);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)!.args.includes("--no-auto-commit"), "run should pass --no-auto-commit");

    const on = await postJson(`${server.url}/api/engine-config`, { autoCommit: true }, { "X-Forge-Token": token });
    assert.equal((on.body as { ok: boolean }).ok, true);
    const run2 = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.ok(!spawned.calls.at(-1)!.args.includes("--no-auto-commit"), "default on: no --no-auto-commit flag");
  }, { repoRoot: true, registered: true });
});

test("engine-config toggles harness activity logging and flows into service-run entrypoint args", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    assert.equal((await getJson(`${server.url}/api/summary`) as { logHarnessActivity: boolean }).logHarnessActivity, false);

    const on = await postJson(`${server.url}/api/engine-config`, { logHarnessActivity: true }, { "X-Forge-Token": token });
    assert.equal((on.body as { ok: boolean }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")).logHarnessActivity, true);
    assert.equal((await getJson(`${server.url}/api/summary`) as { logHarnessActivity: boolean }).logHarnessActivity, true);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)!.args.includes("--log-harness-activity"), "run should pass --log-harness-activity");
    assert.ok(!spawned.calls.at(-1)!.args.includes("--no-log-harness-activity"), "enabled run must not pass the off flag");

    const off = await postJson(`${server.url}/api/engine-config`, { logHarnessActivity: false }, { "X-Forge-Token": token });
    assert.equal((off.body as { ok: boolean }).ok, true);
    const run2 = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.ok((run2.body as { ok: boolean }).ok);
    assert.ok(spawned.calls.at(-1)!.args.includes("--no-log-harness-activity"), "disabled run should pass the off flag");
  }, { repoRoot: true, registered: true });
});

test("host execution is the default and worker execution is an explicit opt-out", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    assert.equal((await getJson(`${server.url}/api/summary`) as { hostExecution: boolean }).hostExecution, true);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)!.args.includes("--host-execution"));

    const disabled = await postJson(`${server.url}/api/engine-config`, { hostExecution: false }, { "X-Forge-Token": token });
    assert.equal((disabled.body as { ok: boolean }).ok, true);
    assert.equal((await getJson(`${server.url}/api/summary`) as { hostExecution: boolean }).hostExecution, false);
    const config = JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8"));
    assert.equal(config.executor, "worker");
    assert.equal(config.hostExecution, false);

    const workerRun = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((workerRun.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)!.args.includes("--worker-execution"));
    assert.ok(!spawned.calls.at(-1)!.args.includes("--host-execution"));

    const rejected = await postJson(`${server.url}/api/engine-config`, { hostExecution: true }, { "X-Forge-Token": token });
    assert.equal(rejected.status, 400);
    assert.match((rejected.body as { message: string }).message, /explicit confirmation/);

    const enabled = await postJson(
      `${server.url}/api/engine-config`,
      { hostExecution: true, confirmed: true },
      { "X-Forge-Token": token },
    );
    assert.equal((enabled.body as { ok: boolean }).ok, true);
    assert.equal((await getJson(`${server.url}/api/summary`) as { hostExecution: boolean }).hostExecution, true);
    assert.equal(JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")).executor, "host");
  }, { repoRoot: true, registered: true });
});

const availableRunner: RunnerReadiness = {
  repositoryId: "test-repository",
  registered: true,
  capabilityEnabled: true,
  hostRunnerStatus: "running",
  available: true,
  blocker: null,
};

test("a per-run executor overrides the saved default without changing it", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const configFile = join(repo, "docs", "engine-config.json");
    assert.equal(existsSync(configFile), false);

    const host = await postJson(`${server.url}/api/control`, { action: "run", executor: "host" }, { "X-Forge-Token": token });
    assert.equal((host.body as { ok: boolean }).ok, true);
    assert.ok(spawned.calls.at(-1)!.args.includes("--host-execution"), "an explicit host choice must reach run");
    assert.equal(existsSync(configFile), false, "a per-run choice must not persist");

    const enabled = await postJson(`${server.url}/api/engine-config`, { hostExecution: true, confirmed: true }, { "X-Forge-Token": token });
    assert.equal((enabled.body as { ok: boolean }).ok, true);

    const worker = await postJson(`${server.url}/api/control`, { action: "run", executor: "worker" }, { "X-Forge-Token": token });
    assert.equal((worker.body as { ok: boolean }).ok, true);
    assert.ok(!spawned.calls.at(-1)!.args.includes("--host-execution"), "an explicit worker choice must not fall back to the saved host default");
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).hostExecution, true, "the saved default is unchanged");
  }, { repoRoot: true, registered: true, runner: availableRunner });
});

test("a per-run host choice is rejected before submission when the runner is unavailable", async () => {
  const unavailable: RunnerReadiness = {
    repositoryId: "test-repository",
    registered: true,
    capabilityEnabled: false,
    hostRunnerStatus: "stopped",
    available: false,
    blocker: "Enable this project's host-runner capability, then restart the runtime.",
  };
  await withServer(async (server, _repo, spawned) => {
    const res = await postJson(`${server.url}/api/control`, { action: "run", executor: "host" }, { "X-Forge-Token": server.token });
    assert.equal(res.status, 409);
    assert.equal((res.body as { code: string }).code, "host-runner-unavailable");
    assert.match((res.body as { message: string }).message, /capability/);
    assert.equal(spawned.calls.length, 0, "no run job should start for a blocked host request");
  }, { repoRoot: true, registered: true, runner: unavailable });
});

test("an unknown executor is rejected", async () => {
  await withServer(async (server) => {
    const res = await postJson(`${server.url}/api/control`, { action: "run", executor: "sandbox" }, { "X-Forge-Token": server.token });
    assert.equal(res.status, 400);
    assert.match((res.body as { message: string }).message, /executor must be 'worker' or 'host'/);
  }, { repoRoot: true, registered: true, runner: availableRunner });
});

test("runner readiness is exposed for the selected project", async () => {
  await withServer(async (server) => {
    const readiness = await getJson(`${server.url}/api/runner-readiness`) as RunnerReadiness;
    assert.deepEqual(readiness, availableRunner);
  }, { repoRoot: true, runner: availableRunner });
});

test("host preflight checks fresh readiness instead of the display cache", async () => {
  let available: RunnerReadiness = availableRunner;
  await withServer(async (server, _repo, spawned) => {
    assert.equal((await getJson(`${server.url}/api/runner-readiness`) as RunnerReadiness).available, true);
    available = { ...availableRunner, available: false, hostRunnerStatus: "stopped", blocker: "The native host runner is not running." };

    const res = await postJson(`${server.url}/api/control`, { action: "run", executor: "host" }, { "X-Forge-Token": server.token });
    assert.equal(res.status, 409);
    assert.equal((res.body as { code: string }).code, "host-runner-unavailable");
    assert.equal(spawned.calls.length, 0);
  }, { repoRoot: true, registered: true, runner: () => available });
});

test("engine-config rejects a non-boolean harness activity value", async () => {
  await withServer(async (server, _repo) => {
    const res = await postJson(`${server.url}/api/engine-config`, { logHarnessActivity: "yes" }, { "X-Forge-Token": server.token });
    assert.equal(res.status, 400);
    assert.match((res.body as { message: string }).message, /logHarnessActivity must be a boolean/);
  });
});

test("engine-config sets concurrency and flows into service-run entrypoint args", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    assert.equal((await getJson(`${server.url}/api/summary`) as { concurrency: number }).concurrency, 0);

    const set = await postJson(`${server.url}/api/engine-config`, { concurrency: 3 }, { "X-Forge-Token": token });
    assert.equal((set.body as { ok: boolean }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")).concurrency, "3");
    assert.equal((await getJson(`${server.url}/api/summary`) as { concurrency: number }).concurrency, 3);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, true);
    const runArgs = spawned.calls.at(-1)!.args;
    const concIdx = runArgs.indexOf("--concurrency");
    assert.ok(concIdx !== -1 && runArgs[concIdx + 1] === "3", "run should pass --concurrency 3");

    // Reset to engine default (0)
    const reset = await postJson(`${server.url}/api/engine-config`, { concurrency: 0 }, { "X-Forge-Token": token });
    assert.equal((reset.body as { ok: boolean }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")).concurrency, "");
    assert.equal((await getJson(`${server.url}/api/summary`) as { concurrency: number }).concurrency, 0);

    const run2 = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.ok((run2.body as { ok: boolean }).ok, "run after reset should succeed");
    assert.ok(!spawned.calls.at(-1)!.args.includes("--concurrency"), "no --concurrency arg when at default");
  }, { repoRoot: true, registered: true });
});

test("engine-config stores manual selection and passes it to the service-run entrypoint", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;

    const mode = await postJson(`${server.url}/api/engine-config`, { executionMode: "manual" }, { "X-Forge-Token": token });
    assert.equal((mode.body as { ok: boolean }).ok, true);

    const selection = await postJson(`${server.url}/api/engine-config`, {
      selectionScope: "range",
      selectedTaskIds: ["1.1", "1.2"],
    }, { "X-Forge-Token": token });
    assert.equal((selection.body as { ok: boolean }).ok, true);

    const summary = await getJson(`${server.url}/api/summary`) as {
      executionMode: string;
      selectedTaskCount: number;
      selectedTaskIds: string[];
    };
    assert.equal(summary.executionMode, "manual");
    assert.equal(summary.selectedTaskCount, 2);
    assert.deepEqual(summary.selectedTaskIds, ["1.1", "1.2"]);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, true);
    assert.equal((run.body as { job?: { type: string } }).job?.type, "run");

    const args = spawned.calls.at(-1)!.args;
    assert.ok(args.includes("--execution-mode"), "run should pass --execution-mode");
    assert.ok(args.includes("manual"), "run should pass manual mode");
    assert.ok(args.includes("--selection-scope"), "run should pass --selection-scope");
    assert.ok(args.includes("range"), "run should pass range scope");
    const taskIdx = args.indexOf("--selected-tasks");
    assert.ok(taskIdx !== -1 && args[taskIdx + 1] === "1.1,1.2", "run should pass the selected task ids");

    const config = JSON.parse(readFileSync(join(repo, "docs", "engine-config.json"), "utf8")) as {
      executionMode: string;
      selectionScope: string;
      selectedTaskIds: string[];
    };
    assert.equal(config.executionMode, "manual");
    assert.equal(config.selectionScope, "range");
    assert.deepEqual(config.selectedTaskIds, ["1.1", "1.2"]);
  }, { repoRoot: true, registered: true });
});

test("manual mode requires at least one selected task before run/resume", async () => {
  await withServer(async (server) => {
    const token = server.token;
    const mode = await postJson(`${server.url}/api/engine-config`, { executionMode: "manual" }, { "X-Forge-Token": token });
    assert.equal((mode.body as { ok: boolean }).ok, true);
    const clear = await postJson(`${server.url}/api/engine-config`, { selectionScope: null, selectedTaskIds: [] }, { "X-Forge-Token": token });
    assert.equal((clear.body as { ok: boolean }).ok, true);

    const run = await postJson(`${server.url}/api/control`, { action: "run" }, { "X-Forge-Token": token });
    assert.equal((run.body as { ok: boolean }).ok, false);
    assert.match((run.body as { message: string }).message, /Manual mode is enabled/);

    const resume = await postJson(`${server.url}/api/control`, { action: "resume" }, { "X-Forge-Token": token });
    assert.equal((resume.body as { ok: boolean }).ok, false);
    assert.match((resume.body as { message: string }).message, /Manual mode is enabled/);
  }, { repoRoot: true, registered: true });
});

test("manual resume does not infer selection from legacy paused state", async () => {
  await withServer(async (server, repo, spawned) => {
    const token = server.token;
    const docs = join(repo, "docs");
    const pausedState = {
      runId: "run-2",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      manifestPath: join(docs, "EXECUTION-MANIFEST.json"),
      manifestVersion: "1.0",
      harness: "opencode",
      status: "paused",
      currentPhase: "1",
      tasks: {
        "1.1": { taskId: "1.1", status: "complete", ownerAgent: "qa-engineer", attempt: 1, outputFiles: [] },
        "1.2": { taskId: "1.2", status: "pending", ownerAgent: "qa-engineer", attempt: 0, outputFiles: [] },
      },
      blockers: [],
      selection: { mode: "manual", scope: "single", taskIds: ["1.2"] },
    };
    writeFileSync(join(docs, "WORKFLOW-STATE.json"), JSON.stringify(pausedState), "utf8");

    const mode = await postJson(`${server.url}/api/engine-config`, { executionMode: "manual" }, { "X-Forge-Token": token });
    assert.equal((mode.body as { ok: boolean }).ok, true);
    const configPath = join(docs, "engine-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { executionMode: string; selectionScope?: string; selectedTaskIds?: string[] };
    delete config.selectionScope;
    config.selectedTaskIds = [];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const legacyState = readFileSync(join(docs, "WORKFLOW-STATE.json"), "utf8");

    const resume = await postJson(`${server.url}/api/control`, { action: "resume" }, { "X-Forge-Token": token });
    assert.equal((resume.body as { ok: boolean }).ok, false);
    assert.match((resume.body as { message: string }).message, /Select at least one task/);
    assert.equal(spawned.calls.length, 0);
    assert.equal(readFileSync(join(docs, "WORKFLOW-STATE.json"), "utf8"), legacyState);
  }, { repoRoot: true, registered: true });
});

test("updating manual selection changes execution config without writing legacy state", async () => {
  await withServer(async (server, repo) => {
    const token = server.token;
    const docs = join(repo, "docs");
    const pausedState = {
      runId: "run-2",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      manifestPath: join(docs, "EXECUTION-MANIFEST.json"),
      manifestVersion: "1.0",
      harness: "opencode",
      status: "paused",
      currentPhase: "1",
      tasks: {
        "1.1": { taskId: "1.1", status: "complete", ownerAgent: "qa-engineer", attempt: 1, outputFiles: [] },
        "1.2": { taskId: "1.2", status: "pending", ownerAgent: "qa-engineer", attempt: 0, outputFiles: [] },
      },
      blockers: [],
      selection: { mode: "manual", scope: "single", taskIds: ["1.1"] },
    };
    writeFileSync(join(docs, "WORKFLOW-STATE.json"), JSON.stringify(pausedState), "utf8");
    const legacyState = readFileSync(join(docs, "WORKFLOW-STATE.json"), "utf8");

    const mode = await postJson(`${server.url}/api/engine-config`, { executionMode: "manual" }, { "X-Forge-Token": token });
    assert.equal((mode.body as { ok: boolean }).ok, true);

    const selection = await postJson(`${server.url}/api/engine-config`, {
      selectionScope: "single",
      selectedTaskIds: ["1.2"],
    }, { "X-Forge-Token": token });
    assert.equal((selection.body as { ok: boolean }).ok, true);

    assert.equal(readFileSync(join(docs, "WORKFLOW-STATE.json"), "utf8"), legacyState);

    const summary = await getJson(`${server.url}/api/summary`) as { selectedTaskIds: string[]; selectedTaskCount: number };
    assert.deepEqual(summary.selectedTaskIds, ["1.2"]);
    assert.equal(summary.selectedTaskCount, 1);
  });
});

test("serves the Console-owned Board renderer and its assets", async () => {
  await withServer(async (server) => {
    const page = await getText(`${server.url}/board`);
    assert.equal(page.status, 200);
    const html = page.body;
    assert.match(html, /\/board\/app\.js/);
    assert.match(html, /\/board\/vendor\/pixi\.min\.js/);

    const app = await getText(`${server.url}/board/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.body, /\/api\/summary/);
    assert.match(app.body, /\/api\/tasks/);
    assert.doesNotMatch(app.body, /\/api\/state/);

    const pixi = await getText(`${server.url}/board/vendor/pixi.min.js`);
    assert.equal(pixi.status, 200);
    assert.ok(pixi.body.length > 100_000);
  });
});

test("the board layout endpoint serves both the kanban and the gantt layout", async () => {
  const repo = makeRepo();
  // A completed task contributes a measured duration the Gantt can estimate from.
  writeFileSync(join(repo, "docs", "EXECUTION-AUDIT.jsonl"),
    `${JSON.stringify({ timestamp: "2026-01-01T00:02:00.000Z", action: "task.complete", taskId: "1.1", durationMs: 120000 })}\n`, "utf8");
  const logs: string[] = [];
  const server = await startConsoleServer({ repoRoot: repo, port: nextPort(), open: false, onLog: (message) => logs.push(message) });
  try {
    const layout = await getJson(`${server.url}/api/layout`) as {
      kanban: { columns: unknown[]; phases: unknown[]; tasks: unknown[] };
      gantt: { rows: unknown[]; bars: Array<{ taskId: string; kind: string }>; axis: { min: number }; forecastEndMs: number };
    };
    assert.equal(layout.kanban.columns.length, 4);
    assert.equal(layout.kanban.tasks.length, 2);
    assert.deepEqual(layout.gantt.bars.map((bar) => bar.taskId).sort(), ["1.1", "1.2"]);
    // Execution state is sourced from the service-run API, not archived legacy state.
    assert.equal(layout.gantt.bars.find((bar) => bar.taskId === "1.1")?.kind, "planned");
    assert.equal(layout.gantt.bars.find((bar) => bar.taskId === "1.2")?.kind, "planned");
    assert.ok(layout.gantt.rows.length >= 2);
    assert.ok(Number.isFinite(layout.gantt.axis.min));
    assert.ok(layout.gantt.forecastEndMs >= layout.gantt.axis.min);
    assert.deepEqual(logs.filter((line) => line.includes("board layout unavailable")), []);
  } finally {
    await server.stop();
  }
});

test("the board layout endpoint is null without a manifest, and survives an engine that cannot load", async () => {
  const repo = makeRepo();
  rmSync(join(repo, "docs", "EXECUTION-MANIFEST.json"), { force: true });
  const server = await startConsoleServer({ repoRoot: repo, port: nextPort(), open: false, onLog: () => {} });
  try {
    assert.equal(await getJson(`${server.url}/api/layout`), null);
  } finally {
    await server.stop();
  }
});

test("launch-cli opens the harness CLI in a terminal (opencode for .agents)", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-home-"));
  const prevHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  const repo = makeRepo();
  const calls: Array<{ cli: string; dir: string; args: string[] }> = [];
  const server = await startConsoleServer({
    repoRoot: repo,
    port: nextPort(),
    open: false,
    onLog: () => {},
    allowExternalOpen: true,
    launchCli: async (cli, dir, args) => { calls.push({ cli, dir, args }); return true; },
  });
  try {
    const res = await postJson(`${server.url}/api/launch-cli`, {}, { "X-Forge-Token": server.token });
    const body = res.body as { ok: boolean; launched?: boolean; cli?: string; command?: string };
    assert.equal(body.ok, true);
    assert.equal(body.launched, true);
    assert.equal(body.cli, "opencode");
    assert.deepEqual(calls, [{ cli: "opencode", dir: repo, args: ["."] }]);
    assert.match(body.command ?? "", /opencode \.$/);
  } finally {
    await server.stop();
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  }
});

test("launch-cli chooses copilot for a GitHub harness and reports the manual fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-home-"));
  const prevHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  const repo = makeRepo();
  moveFixtureToGithub(repo);
  const calls: Array<{ cli: string; dir: string; args: string[] }> = [];
  const server = await startConsoleServer({
    repoRoot: repo,
    port: nextPort(),
    open: false,
    onLog: () => {},
    allowExternalOpen: true,
    launchCli: async (cli, dir, args) => { calls.push({ cli, dir, args }); return false; },
  });
  try {
    const res = await postJson(`${server.url}/api/launch-cli`, {}, { "X-Forge-Token": server.token });
    const body = res.body as { ok: boolean; launched?: boolean; cli?: string; command?: string };
    assert.equal(body.launched, false);
    assert.equal(body.cli, "copilot");
    assert.deepEqual(calls, [{ cli: "copilot", dir: repo, args: [] }]);
    assert.match(body.message ?? "", /run it manually/);
    assert.match(body.command ?? "", /copilot/);

    const unauth = await postJson(`${server.url}/api/launch-cli`, {});
    assert.equal(unauth.status, 403);
  } finally {
    await server.stop();
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  }
});

test("model planning endpoint launches the selected interactive CLI", async () => {
  await withServer(async (server, repo) => {
    const calls: Array<{ cli: string; dir: string; args: string[] }> = [];
    // This test uses a second server seam because the shared fixture intentionally
    // does not enable external terminal launches.
    await server.stop();
    const replacement = await startConsoleServer({
      repoRoot: repo,
      port: nextPort(),
      open: false,
      allowExternalOpen: true,
      onLog: () => {},
      launchCli: async (cli, dir, args) => { calls.push({ cli, dir, args }); return true; },
    });
    try {
      const result = await postJson(`${replacement.url}/api/model-plan/terminal`, { provider: "copilot", message: "Review MODEL-PLAN.md" }, { "X-Forge-Token": replacement.token });
      assert.equal((result.body as { ok: boolean }).ok, true);
      assert.deepEqual(calls[0], { cli: "copilot", dir: repo, args: ["-i", "Review MODEL-PLAN.md", "--yolo"] });
    } finally {
      await replacement.stop();
    }
  });
});

test("model planning endpoint launches claude with the message as a positional prompt", async () => {
  await withServer(async (server, repo) => {
    const calls: Array<{ cli: string; dir: string; args: string[] }> = [];
    // Same second-server seam as the copilot case: the shared fixture does not
    // enable external terminal launches.
    await server.stop();
    const replacement = await startConsoleServer({
      repoRoot: repo,
      port: nextPort(),
      open: false,
      allowExternalOpen: true,
      onLog: () => {},
      launchCli: async (cli, dir, args) => { calls.push({ cli, dir, args }); return true; },
    });
    try {
      const result = await postJson(`${replacement.url}/api/model-plan/terminal`, { provider: "claude", message: "Review MODEL-PLAN.md" }, { "X-Forge-Token": replacement.token });
      assert.equal((result.body as { ok: boolean }).ok, true);
      assert.deepEqual(calls[0], { cli: "claude", dir: repo, args: ["Review MODEL-PLAN.md"] });
    } finally {
      await replacement.stop();
    }
  });
});

test("authoring session endpoint launches an interactive grill session", async () => {
  await withServer(async (server, repo) => {
    const calls: Array<{ cli: string; dir: string; args: string[] }> = [];
    await server.stop();
    const replacement = await startConsoleServer({
      repoRoot: repo,
      port: nextPort(),
      open: false,
      onLog: () => {},
      allowExternalOpen: true,
      launchCli: async (cli, dir, args) => { calls.push({ cli, dir, args }); return true; },
    });
    try {
      const idea = await postJson(`${replacement.url}/api/authoring/session`, { target: "idea" }, { "X-Forge-Token": replacement.token });
      assert.equal((idea.body as { ok: boolean }).ok, true);
      assert.equal(calls[0]?.cli, "opencode");
      assert.equal(calls[0]?.args[0], "mini");
      assert.equal(calls[0]?.args[1], "--prompt");
      assert.match(calls[0]?.args[2] ?? "", /forge-grill-idea/);

      const prd = await postJson(`${replacement.url}/api/authoring/session`, { target: "prd" }, { "X-Forge-Token": replacement.token });
      assert.equal((prd.body as { ok: boolean }).ok, true);
      assert.match(calls[1]?.args[2] ?? "", /forge-auto-build-prd/);

      const missingPrompt = await postJson(`${replacement.url}/api/authoring/session`, { target: "feature-prd" }, { "X-Forge-Token": replacement.token });
      assert.equal(missingPrompt.status, 400);

      const feature = await postJson(`${replacement.url}/api/authoring/session`, { target: "feature-prd", prompt: "add billing" }, { "X-Forge-Token": replacement.token });
      assert.equal((feature.body as { ok: boolean }).ok, true);
      assert.match(calls[2]?.args[2] ?? "", /forge-build-feature-prd/);
      assert.match(calls[2]?.args[2] ?? "", /add billing/);
      const handoff = JSON.parse(readFileSync(join(repo, "docs", "authoring-state.json"), "utf8")).featureIncrementHandoff;
      assert.deepEqual(Object.keys(handoff.featureFingerprints), ["fixture.md"]);
      assert.equal(featureIncrementHandoffHasChange(repo), false, "the session receipt captures the pre-session feature fingerprint");

      const unknown = await postJson(`${replacement.url}/api/authoring/session`, { target: "nope" }, { "X-Forge-Token": replacement.token });
      assert.equal(unknown.status, 400);
    } finally {
      await replacement.stop();
    }
  });
});

test("authoring session endpoint is disabled without external open", async () => {
  await withServer(async (server) => {
    const res = await postJson(`${server.url}/api/authoring/session`, { target: "idea" }, { "X-Forge-Token": server.token });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ok: boolean }).ok, false);
  });
});

test("model inventory and overrides preserve provider-qualified IDs", async () => {
  const root = makeRepo();
  const docsResearch = join(root, "docs", "research");
  mkdirSync(docsResearch, { recursive: true });
  writeFileSync(join(docsResearch, "model-inventory.json"), JSON.stringify({
    opencode_cli: { models: [{ id: "github-copilot/gpt-5.6-luna" }] },
  }), "utf8");
  const paths = (await import("./console/paths.ts")).repoPaths(root);
  const repo = await import("./console/repo.ts");

  assert.deepEqual(repo.modelInventory(paths).models[0]?.id, "github-copilot/gpt-5.6-luna");
  assert.equal(repo.setModelOverride(paths, "agent", "github-copilot/gpt-5.6-luna").ok, true);
});

test("runtime Console API requires the operator token and serializes mutations", async (t) => {
  const state: RuntimeAdminState = {
    project: "myforge-runtime",
    initialized: false,
    status: "not-initialized",
    containers: [],
    missingServices: ["postgres", "placement", "scheduler", "daprd", "forge"],
    diagnostics: [],
    repositories: [],
    hostRunnerEnabledRepositoryIds: [],
    hostRunnerStatus: "disabled",
    harnessGrants: { copilot: [], claude: [], opencode: [] },
    startOptions: null,
    restartRequired: false,
  };
  let entered!: () => void;
  const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (result: { message: string; restartRequired: boolean }) => void;
  const server = await startConsoleServer({
    port: nextPort(),
    open: false,
    runtimeAdmin: {
      state: async () => state,
      execute: async () => {
        entered();
        return new Promise((resolve) => { finish = resolve; });
      },
    },
  });
  t.after(() => server.stop());

  const status = await signedFetch(`${server.url}/api/runtime`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), state);

  const url = `${server.url}/api/runtime/action`;
  const request = (body: unknown, includeToken = true) => signedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(includeToken ? { "X-Forge-Token": server.token } : {}),
    },
    body: JSON.stringify(body),
  });
  assert.equal((await request({ action: "stop", confirmed: true }, false)).status, 403);
  assert.equal((await request({ action: "reset", confirmed: false })).status, 400);

  const first = request({ action: "start", hostTools: false });
  await operationEntered;
  const second = await request({ action: "stop", confirmed: true });
  assert.equal(second.status, 409);

  finish({ message: "Local infrastructure is running.", restartRequired: false });
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, message: "Local infrastructure is running.", restartRequired: false });
});
