import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertLocalDeployment, serviceEngineRun, serviceResume, type ServiceRunDependencies } from "./service-run.ts";

const REPOSITORY_ID = "smoke";

function readyRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "service-run-"));
  fs.mkdirSync(path.join(repo, "docs", "features"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "PRD.md"), "# PRD\n");
  fs.writeFileSync(path.join(repo, "docs", "features", "one.md"), "# One\n");
  fs.writeFileSync(path.join(repo, "docs", "EXECUTION-MANIFEST.json"), "{}\n");
  return repo;
}

interface FakeRun { runId: string; status: string; targetRef: string; createdAt: string }

/** A service whose runs pause or complete as soon as they are followed. */
function fakeService(runs: FakeRun[], finalStatus = "complete") {
  const controls: Array<{ runId: string; action: string }> = [];
  const submitted: unknown[] = [];
  const events = new Map<string, Array<Record<string, unknown>>>();
  const client = {
    async list() { return { runs: runs as unknown as Array<Record<string, unknown>> }; },
    async get(runId: string) { return runs.find((run) => run.runId === runId) as unknown as Record<string, unknown>; },
    async events(runId: string, after = 0) {
      const all = events.get(runId) ?? [];
      const page = all.filter((event) => Number(event.sequence) > after);
      const cursor = page.length ? Number(page.at(-1)!.sequence) : after;
      return { events: page, cursor, hasMore: false };
    },
    async control(runId: string, action: string) {
      controls.push({ runId, action });
      const run = runs.find((entry) => entry.runId === runId)!;
      if (action === "resume") finish(run);
      return { controlId: "c1", state: "accepted" };
    },
    async submit() { throw new Error("unused"); },
  };
  function finish(run: FakeRun): void {
    run.status = finalStatus;
    const list = events.get(run.runId) ?? [];
    const sequence = list.length + 1;
    list.push({
      sequence,
      eventType: finalStatus === "paused" ? "run.paused" : `run.${finalStatus === "complete" ? "completed" : finalStatus}`,
      runStatus: finalStatus,
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    events.set(run.runId, list);
  }
  const submit: NonNullable<ServiceRunDependencies["submit"]> = async (_client, input) => {
    submitted.push(input);
    const run = { runId: "run-new", status: "queued", targetRef: "refs/heads/forge/main", createdAt: "2026-10-02" };
    runs.push(run);
    finish(run);
    return { runId: run.runId, forgeBranch: "forge/main", reused: false, status: "queued" };
  };
  return { client, controls, submitted, submit, events, finish };
}

function dependencies(service: ReturnType<typeof fakeService>, output: string[]): ServiceRunDependencies {
  return {
    repositoryId: async () => REPOSITORY_ID,
    client: async () => service.client as never,
    write: (text) => { output.push(text); },
    submit: service.submit,
    compile: async () => { throw new Error("compile should not run"); },
    pollMs: 1,
  };
}

test("deployment selection accepts local and rejects hosted or unknown values", () => {
  assert.doesNotThrow(() => assertLocalDeployment({}));
  assert.doesNotThrow(() => assertLocalDeployment({ FORGE_DEPLOYMENT: "local" }));
  assert.throws(() => assertLocalDeployment({ FORGE_DEPLOYMENT: "hosted" }), /not available yet/);
  assert.throws(() => assertLocalDeployment({ FORGE_DEPLOYMENT: "cloud" }), /Unknown FORGE_DEPLOYMENT/);
});

test("unregistered repositories fail closed instead of starting the legacy engine", async () => {
  const repo = readyRepo();
  await assert.rejects(
    serviceEngineRun(["--repo", repo, "--some-legacy-flag"], { repositoryId: async () => undefined }),
    /not registered with the local execution service.*runtime repo add.*restart the runtime.*histories are not imported/s,
  );
  assert.equal(await serviceResume({ repo }, { repositoryId: async () => undefined }), undefined);
});

test("stop and pause send a control to the active run", async () => {
  const repo = readyRepo();
  const service = fakeService([
    { runId: "old", status: "complete", targetRef: "refs/heads/forge/main", createdAt: "2026-09-01" },
    { runId: "live", status: "running", targetRef: "refs/heads/forge/main", createdAt: "2026-09-02" },
  ]);
  const output: string[] = [];
  assert.equal(await serviceEngineRun(["--repo", repo, "--stop"], dependencies(service, output)), 0);
  assert.equal(await serviceEngineRun(["--repo", repo, "--pause"], dependencies(service, output)), 0);
  assert.deepEqual(service.controls, [{ runId: "live", action: "stop" }, { runId: "live", action: "pause" }]);
  assert.match(output.join(""), /Control stop c1 is accepted for run live/);

  const idle = fakeService([]);
  const idleOutput: string[] = [];
  assert.equal(await serviceEngineRun(["--repo", repo, "--stop"], dependencies(idle, idleOutput)), 0);
  assert.match(idleOutput.join(""), /No active service run/);
});

test("a paused run is resumed and followed until it completes", async () => {
  const repo = readyRepo();
  const service = fakeService([{ runId: "paused", status: "paused", targetRef: "refs/heads/forge/main", createdAt: "2026-09-02" }]);
  const output: string[] = [];
  const code = await serviceEngineRun(["--repo", repo, "--yes", "--task-timeout-ms", "5000", "--viz"], dependencies(service, output));
  assert.equal(code, 0);
  assert.deepEqual(service.controls, [{ runId: "paused", action: "resume" }]);
  assert.equal(service.submitted.length, 0);
  const text = output.join("");
  assert.match(text, /Resuming service run paused/);
  assert.match(text, /--task-timeout-ms is ignored/);
  assert.match(text, /--viz is ignored/);
  assert.doesNotMatch(text, /--yes is ignored/);
  assert.match(text, /service merge paused/);
});

test("a run that pauses again returns cleanly with resume guidance", async () => {
  const repo = readyRepo();
  const service = fakeService([{ runId: "p", status: "paused", targetRef: "refs/heads/forge/main", createdAt: "2026-09-02" }], "paused");
  const output: string[] = [];
  assert.equal(await serviceEngineRun(["--repo", repo], dependencies(service, output)), 0);
  assert.match(output.join(""), /Resume with: forge-launcher engine-run/);
});

test("a running run is attached to without a second submission", async () => {
  const repo = readyRepo();
  const run = { runId: "live", status: "running", targetRef: "refs/heads/forge/main", createdAt: "2026-09-02" };
  const service = fakeService([run], "failed");
  const output: string[] = [];
  const pending = serviceEngineRun(["--repo", repo], dependencies(service, output));
  setTimeout(() => service.finish(run), 5);
  assert.equal(await pending, 1);
  assert.equal(service.submitted.length, 0);
  assert.deepEqual(service.controls, []);
  assert.match(output.join(""), /Attaching to service run live \(running\)/);
});

test("without an active run a new run is submitted with service settings", async () => {
  const repo = readyRepo();
  const service = fakeService([]);
  const output: string[] = [];
  const code = await serviceEngineRun([
    "--repo", repo, "--harness", "stub", "--concurrency", "2", "--max-retries", "1", "--allow-noop", "--host-execution",
    "--execution-mode", "manual", "--selected-tasks", "T1, T2", "--selection-scope", "phase",
  ], dependencies(service, output));
  assert.equal(code, 0);
  assert.equal(service.submitted.length, 1);
  const input = service.submitted[0] as Record<string, unknown>;
  assert.equal(input.harness, "stub");
  assert.equal(input.repositoryId, REPOSITORY_ID);
  assert.deepEqual(input.settings, { concurrency: 2, maxRetries: 1, allowNoop: true, hostExecution: true });
  assert.deepEqual(input.requestedTaskIds, ["T1", "T2"]);
  assert.match(output.join(""), /Submitted service run run-new -> forge\/main/);
});

test("invalid service options are rejected before contacting the service", async () => {
  const repo = readyRepo();
  const service = fakeService([]);
  const output: string[] = [];
  await assert.rejects(serviceEngineRun(["--repo", repo, "--execution-mode", "manual"], dependencies(service, output)), /--selected-tasks/);
  await assert.rejects(serviceEngineRun(["--repo", repo, "--bogus"], dependencies(service, output)), /Unknown option: --bogus/);
  await assert.rejects(serviceEngineRun(["--repo", repo, "--concurrency", "two"], dependencies(service, output)), /non-negative integer/);
  await assert.rejects(serviceEngineRun(["--repo", repo, "--granularity", "huge"], dependencies(service, output)), /Invalid --granularity/);
  fs.rmSync(path.join(repo, "docs", "PRD.md"));
  await assert.rejects(serviceEngineRun(["--repo", repo], dependencies(service, output)), /PRD/);
  assert.equal(service.submitted.length, 0);
});

test("dry-run describes the service action without contacting the service", async () => {
  const repo = readyRepo();
  fs.rmSync(path.join(repo, "docs", "EXECUTION-MANIFEST.json"));
  const output: string[] = [];
  const code = await serviceEngineRun(["--repo", repo, "--dry-run", "--harness", "stub"], {
    repositoryId: async () => REPOSITORY_ID,
    client: async () => { throw new Error("dry-run must not contact the service"); },
    write: (text) => { output.push(text); },
  });
  assert.equal(code, 0);
  assert.match(output.join(""), /\[dry-run\] would compile/);
  assert.match(output.join(""), /\[dry-run\] would resume the active service run or submit/);
});

test("non-interactive resume reports the active run instead of following it", async () => {
  const repo = readyRepo();
  const service = fakeService([{ runId: "p", status: "paused", targetRef: "refs/heads/forge/main", createdAt: "2026-09-02" }]);
  const output: string[] = [];
  assert.equal(await serviceResume({ repo, nonInteractive: true }, dependencies(service, output)), 0);
  assert.deepEqual(service.controls, []);
  assert.match(output.join(""), /Service run p is paused/);
  assert.equal(await serviceResume({ repo }, dependencies(fakeService([]), output)), undefined);
});
