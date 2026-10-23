import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRunSubmission, prepareForgeBranch, ServiceApiError, ServiceClient, serviceCli } from "./service-client.ts";

const RUN_ID = `run_${"a".repeat(32)}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

async function repository(t: test.TestContext): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "forge-service-client-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function commit(repo: string, message: string): void {
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message);
}

test("submissions freeze agent descriptors into the digested snapshot", () => {
  const digested: unknown[] = [];
  const submission = buildRunSubmission({
    manifest: { version: "1.0", phases: [] },
    agents: [{ name: "builder", description: "d", path: "agents/builder.md", expertise: [], collaboration: [], constraints: [], rawBody: "x", extra: "dropped" }],
    repositoryId: "demo",
    targetRef: "refs/heads/forge/main",
    harness: "stub",
    settings: { concurrency: 2, allowNoop: true },
    requestedTaskIds: ["T1"],
    submissionKey: "key-1",
  }, (snapshot) => { digested.push(snapshot); return `sha256:${"0".repeat(64)}`; });

  const snapshot = submission.manifestSnapshot as { agents: Record<string, unknown>[] };
  assert.deepEqual(digested, [snapshot]);
  assert.deepEqual(Object.keys(snapshot.agents[0]!), ["name", "description", "path", "expertise", "collaboration", "constraints", "rawBody"]);
  assert.deepEqual(submission.selection, { mode: "manual", requestedTaskIds: ["T1"] });
  assert.deepEqual(submission.configuration, { settings: { concurrency: 2, allowNoop: true }, secretRefs: {} });
  assert.equal(submission.submissionKey, "key-1");
  const generated = buildRunSubmission({ ...{ manifest: { phases: [] }, agents: [], repositoryId: "demo", targetRef: "refs/heads/forge/main", harness: "stub", settings: {}, requestedTaskIds: [] } }, () => "d");
  assert.match(String(generated.submissionKey), /^cli-[0-9a-f-]{36}$/);
  assert.deepEqual(generated.selection, { mode: "auto", requestedTaskIds: [] });
});

test("forge branches start at HEAD, fast-forward when behind, and are kept when diverged", async (t) => {
  const repo = await repository(t);
  const first = prepareForgeBranch(repo);
  assert.deepEqual(first, { targetRef: "refs/heads/forge/main", created: true });
  assert.equal(git(repo, "rev-parse", "forge/main"), git(repo, "rev-parse", "HEAD"));

  commit(repo, "ahead");
  assert.deepEqual(prepareForgeBranch(repo), { targetRef: "refs/heads/forge/main", created: false });
  assert.equal(git(repo, "rev-parse", "forge/main"), git(repo, "rev-parse", "HEAD"));

  git(repo, "checkout", "-q", "forge/main");
  await assert.rejects(async () => prepareForgeBranch(repo), /is checked out/);
  commit(repo, "forge work");
  const forgeTip = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  commit(repo, "diverged");
  const diverged = prepareForgeBranch(repo);
  assert.match(diverged.note ?? "", /unmerged Forge commits/);
  assert.equal(git(repo, "rev-parse", "forge/main"), forgeTip);

  assert.equal(prepareForgeBranch(repo, "forge/main").targetRef, "refs/heads/forge/main");
  assert.throws(() => prepareForgeBranch(repo, "bad..name"), /not a valid branch name/);
  git(repo, "checkout", "-q", "--detach");
  assert.throws(() => prepareForgeBranch(repo), /HEAD is detached/);
});

test("the client authenticates requests and surfaces service errors", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses = [
    new Response(JSON.stringify({ runId: RUN_ID }), { status: 201 }),
    new Response(JSON.stringify({ error: { code: "unknown-run", message: "missing" } }), { status: 404 }),
    new Response("<html>", { status: 502 }),
  ];
  const client = new ServiceClient("http://127.0.0.1:8483", "t".repeat(64), async (url, init) => {
    requests.push({ url, init });
    return responses.shift()!;
  });
  assert.equal((await client.submit({ a: 1 })).runId, RUN_ID);
  const headers = requests[0]!.init!.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${"t".repeat(64)}`);
  assert.equal(headers["content-type"], "application/json");
  await assert.rejects(client.get(RUN_ID), (error: unknown) => error instanceof ServiceApiError && error.code === "unknown-run" && error.status === 404);
  await assert.rejects(client.list(), /non-JSON/);
  const unreachable = new ServiceClient("http://127.0.0.1:1", "t", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(unreachable.get(RUN_ID), /runtime start/);
});

test("the client requests bounded host-runner summaries with an optional repository filter", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = new ServiceClient("http://127.0.0.1:8483", "t".repeat(64), async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ jobs: [], activeTruncated: false }), { status: 200 });
  });

  assert.deepEqual(await client.hostRunnerJobs("repo_demo"), { jobs: [], activeTruncated: false });
  assert.equal(requests[0]!.url, "http://127.0.0.1:8483/v1/host-runner/jobs?repositoryId=repo_demo");
  const headers = requests[0]!.init!.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${"t".repeat(64)}`);
});

test("service CLI dispatches status, events, controls, and validates arguments", async () => {
  const calls: unknown[][] = [];
  const client = {
    get: async (runId: string) => {
      calls.push(["get", runId]);
      return { runId, status: "running", repositoryId: "demo", targetRef: "refs/heads/forge/main", harness: { id: "stub" }, tasks: [{ taskId: "T1", status: "running", logicalAttempt: 2 }] };
    },
    events: async (runId: string, after: number) => {
      calls.push(["events", runId, after]);
      return { events: [{ sequence: 4, eventType: "task-status", taskId: "T1", taskStatus: "running" }], cursor: 4, hasMore: true };
    },
    control: async (runId: string, action: string, payload: unknown) => {
      calls.push(["control", runId, action, payload]);
      return { action, controlId: "c-1", state: "applied" };
    },
  } as unknown as ServiceClient;
  let output = "";
  const write = (text: string) => { output += text; };

  assert.equal(await serviceCli(["status", RUN_ID], { client, write }), 0);
  assert.match(output, /T1\trunning\tattempt 2/);
  assert.equal(await serviceCli(["events", RUN_ID, "--after", "3"], { client, write }), 0);
  assert.match(output, /#4 task-status task=T1 taskStatus=running\nMore events follow; rerun with --after 4\./);
  assert.equal(await serviceCli(["control", RUN_ID, "replay-task", "--task", "T1"], { client, write }), 0);
  assert.match(output, /Control replay-task c-1 is applied\./);
  assert.deepEqual(calls, [["get", RUN_ID], ["events", RUN_ID, 3], ["control", RUN_ID, "replay-task", { taskId: "T1" }]]);

  await assert.rejects(serviceCli(["control", RUN_ID, "approve-task"], { client, write }), /requires --task/);
  await assert.rejects(serviceCli(["control", RUN_ID, "explode"], { client, write }), /Usage/);
  await assert.rejects(serviceCli(["events", RUN_ID, "--after", "-1"], { client, write }), /requires a value|non-negative/);
  await assert.rejects(serviceCli(["nope"], { client, write }), /Unknown service command/);
  assert.equal(await serviceCli(["--help"], { client, write }), 0);
  assert.equal(await serviceCli([], { client, write }), 1);
});

test("service CLI exports status and the complete audit trail as JSON", async () => {
  const pages = [
    { events: [{ sequence: 1, eventType: "run-status", runStatus: "running" }], cursor: 1, hasMore: true },
    { events: [{ sequence: 2, eventType: "task-status", taskId: "T1", taskStatus: "complete" }], cursor: 2, hasMore: false },
  ];
  const run = { runId: RUN_ID, status: "complete", repositoryId: "demo", targetRef: "refs/heads/forge/main", harness: { id: "stub" } };
  const client = {
    get: async () => run,
    list: async () => ({ runs: [run] }),
    events: async () => pages.shift()!,
  } as unknown as ServiceClient;
  let output = "";
  const write = (text: string) => { output += text; };

  assert.equal(await serviceCli(["status", RUN_ID, "--json"], { client, write }), 0);
  assert.deepEqual(JSON.parse(output), run);
  output = "";
  assert.equal(await serviceCli(["runs", "--json"], { client, write }), 0);
  assert.deepEqual(JSON.parse(output), { runs: [run] });
  output = "";
  assert.equal(await serviceCli(["events", RUN_ID, "--json"], { client, write }), 0);
  assert.deepEqual(output.trim().split("\n").map((line) => JSON.parse(line).sequence), [1, 2]);
  await assert.rejects(serviceCli(["runs", "extra"], { client, write }), /Unexpected argument/);
});

test("a rejected API token explains how to apply rotated tokens", async () => {
  const client = new ServiceClient("http://127.0.0.1:8483", "t".repeat(64), async () =>
    new Response(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized." } }), { status: 401 }));
  await assert.rejects(client.get(RUN_ID), (error: unknown) =>
    error instanceof ServiceApiError && error.status === 401 && /rotate-tokens/.test(error.message) && /runtime start/.test(error.message));
});
