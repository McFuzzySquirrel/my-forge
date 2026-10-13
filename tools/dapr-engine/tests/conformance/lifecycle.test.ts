// Process lifecycle and isolation fixtures (contract v1 §3 "Process lifecycle
// and isolation"). They run real POSIX subprocess trees through runCommand and
// the supervisor, against the in-memory store that shares the contract v1
// decision functions with the PostgreSQL adapter.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationKeyV1 } from "../../contract/v1/index.ts";
import {
  buildHarnessEnvironment,
  checkContainerIsolation,
  createHarnessHome,
  harnessProcessOptions,
  runCommand,
  superviseExecution,
  type SupervisedRunContext,
} from "../../execution/index.ts";
import { InMemoryExecutionStore } from "./support/execution-store.ts";

const posix = process.platform !== "win32";
let operationCounter = 0;
const operation = (): OperationKeyV1 => ({ runId: "run-1", taskId: "T1", logicalAttempt: 1, operationId: `op-${++operationCounter}` });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs = 1000): Promise<boolean> {
  for (let waited = 0; waited < withinMs && alive(pid); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
}

/** Runs `script` as an isolated harness under the supervisor's signal and budget. */
function harness(script: string, cwd: string, timeoutMs?: number) {
  return (context: SupervisedRunContext) => runCommand("sh", ["-c", script], {
    cwd,
    timeoutMs: timeoutMs ?? context.remainingMs,
    maxBufferBytes: 64 * 1024,
    signal: context.signal,
    ...harnessProcessOptions({
      isolation: { environment: { PATH: process.env["PATH"] ?? "" }, onProcessSettled: context.onProcessSettled },
    }),
  });
}

async function withScratch<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "forge-lifecycle-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("C26: deadline and cancellation terminate the owned harness process tree before exit is recorded", { skip: !posix }, async (t) => {
  await t.test("the attempt deadline aborts the harness and its background descendant", () => withScratch(async (cwd) => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    const supervised = await superviseExecution({
      store, key, workerId: "worker-a", budgetMs: 300, heartbeatIntervalMs: 50, heartbeatTtlMs: 1000,
      // The harness's own timeout is far longer: only the supervisor deadline can stop it.
      run: harness("sleep 30 & echo $!; wait", cwd, 30_000),
      exitStatus: (result) => result.status,
    });
    assert.ok(supervised.started);
    assert.equal(supervised.stopReason, "deadline");
    assert.equal(supervised.cleanup, "observed");
    const grandchild = Number(supervised.result?.stdout.trim());
    assert.ok(grandchild > 0);
    assert.ok(await waitUntilDead(grandchild), "background descendant must not outlive the deadline");
    assert.equal(store.execution(key)?.exit?.stopReason, "deadline");
    assert.deepEqual(store.publishOutcome(key, supervised.claim, "effect-published"), { ok: false, code: "deadline-exceeded" });
    assert.deepEqual(store.publishOutcome(key, supervised.claim, "failed", "diag://timeout"), { ok: true });
    assert.equal(store.receipt(key)?.state, "failed");
  }));

  await t.test("a durable cancel request reaches the harness through the heartbeat", () => withScratch(async (cwd) => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    setTimeout(() => store.requestCancel(key, "operator cancel"), 100);
    const supervised = await superviseExecution({
      store, key, workerId: "worker-a", budgetMs: 30_000, heartbeatIntervalMs: 25, heartbeatTtlMs: 1000,
      run: harness("sleep 30 & echo $!; wait", cwd),
    });
    assert.ok(supervised.started);
    assert.equal(supervised.stopReason, "cancel");
    assert.ok(await waitUntilDead(Number(supervised.result?.stdout.trim())));
    assert.equal(store.execution(key)?.state, "exited");
    assert.equal(store.execution(key)?.exit?.cleanup, "observed");
  }));

  await t.test("descendants left behind by a normally exiting harness are reaped", () => withScratch(async (cwd) => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    const supervised = await superviseExecution({
      store, key, workerId: "worker-a", budgetMs: 30_000, heartbeatIntervalMs: 50, heartbeatTtlMs: 1000,
      run: harness("sleep 30 >/dev/null 2>&1 & echo $!", cwd),
      exitStatus: (result) => result.status,
    });
    assert.ok(supervised.started);
    assert.equal(supervised.stopReason, undefined);
    assert.equal(supervised.result?.status, 0);
    assert.ok(await waitUntilDead(Number(supervised.result?.stdout.trim())), "detached-output descendant must be reaped");
    assert.deepEqual(store.publishOutcome(key, supervised.claim, "effect-published"), { ok: true });
  }));

  const packageRoot = join(import.meta.dirname, "..", "..");
  const workerScript = join(import.meta.dirname, "support", "lifecycle-worker.ts");
  async function descendantOf(cwd: string): Promise<number> {
    for (let index = 0; index < 250; index += 1) {
      const text = await readFile(join(cwd, "descendant.pid"), "utf8").catch(() => "");
      if (text.trim()) return Number(text.trim());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("harness never reported its descendant");
  }
  function startWorker(mode: string, cwd: string, timeoutMs?: number) {
    const worker = spawn(process.execPath, ["--import", "tsx", workerScript, mode, cwd, ...(timeoutMs ? [String(timeoutMs)] : [])], {
      cwd: packageRoot, stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    return { worker, exited };
  }

  await t.test("a worker killed mid-attempt takes its harness process tree with it", () => withScratch(async (cwd) => {
    const { worker, exited } = startWorker("crash", cwd);
    const descendant = await descendantOf(cwd);
    assert.ok(alive(descendant));
    worker.kill("SIGKILL");
    await exited;
    assert.ok(await waitUntilDead(descendant), "harness descendant must not outlive a SIGKILLed worker");
  }));

  await t.test("a worker that dies after the harness exits but before reaping still leaves no descendant", () => withScratch(async (cwd) => {
    const { exited } = startWorker("die-before-reap", cwd);
    const descendant = await descendantOf(cwd);
    await exited;
    assert.ok(await waitUntilDead(descendant), "leftover descendant must be killed when the worker dies before reaping");
  }));

  await t.test("an unresponsive worker cannot extend the harness past its hard deadline", () => withScratch(async (cwd) => {
    const { worker, exited } = startWorker("freeze", cwd, 300);
    try {
      const descendant = await descendantOf(cwd);
      // Hard deadline = timeout + cleanup grace (1s); the worker stays frozen for 60s.
      assert.ok(await waitUntilDead(descendant, 4000), "watchdog must kill the tree at the hard deadline");
      assert.equal(worker.exitCode, null, "the worker itself is still frozen");
    } finally {
      worker.kill("SIGKILL");
      await exited;
    }
  }));
});

test("C27: worker loss fences the old epoch; redelivery takes over with the original deadline", async (t) => {
  await t.test("takeover, stale reports, and no relaunch after publication", async () => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    const first = await store.start({ key, workerId: "worker-a", budgetMs: 60_000, heartbeatTtlMs: 1000 });
    assert.ok(first.ok);
    const old = { executionEpoch: first.execution.executionEpoch, workerId: "worker-a" };

    store.advance(500);
    assert.equal((await store.start({ key, workerId: "worker-b", budgetMs: 60_000, heartbeatTtlMs: 1000 })).ok, false,
      "a live owner holds the execution against a duplicate delivery");

    store.advance(600);
    assert.deepEqual(store.fenceLostExecutions().map((execution) => execution.state), ["lost"]);
    const takeover = await store.start({ key, workerId: "worker-b", budgetMs: 1, heartbeatTtlMs: 1000 });
    assert.ok(takeover.ok);
    assert.equal(takeover.execution.executionEpoch, 2);
    assert.equal(takeover.execution.deadlineAt, first.execution.deadlineAt, "redelivery must not reset the attempt budget");
    assert.deepEqual(takeover.execution.lostEpochs, [1]);

    assert.deepEqual(await store.heartbeat(key, old, 1000), { ok: false, code: "stale-execution" });
    assert.deepEqual(await store.recordExit(key, old, { status: 0, cleanup: "observed" }), { ok: false, code: "stale-execution" });
    assert.deepEqual(store.publishOutcome(key, old, "effect-published"), { ok: false, code: "stale-execution" });
    assert.equal(store.receipt(key)?.state, "executing", "a stale epoch never touches the receipt");

    const current = { executionEpoch: 2, workerId: "worker-b" };
    assert.ok((await store.recordExit(key, current, { status: 0, cleanup: "observed" })).ok);
    assert.deepEqual(store.publishOutcome(key, current, "effect-published"), { ok: true });
    assert.deepEqual(await store.start({ key, workerId: "worker-c", budgetMs: 60_000, heartbeatTtlMs: 1000 }),
      { ok: false, code: "receipt-not-executing" });
  });

  await t.test("an elapsed deadline rejects takeover", async () => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    assert.ok((await store.start({ key, workerId: "worker-a", budgetMs: 2000, heartbeatTtlMs: 1000 })).ok);
    store.advance(2500);
    const late = await store.start({ key, workerId: "worker-b", budgetMs: 60_000, heartbeatTtlMs: 1000 });
    assert.equal(late.ok ? undefined : late.code, "deadline-exceeded");
  });

  await t.test("an owner that cannot renew its heartbeat stops its harness", async () => {
    const store = new InMemoryExecutionStore();
    const key = operation();
    store.executingReceipt(key);
    const supervised = await superviseExecution({
      store, key, workerId: "worker-a", budgetMs: 30_000, heartbeatIntervalMs: 25, heartbeatTtlMs: 1000,
      run: async ({ signal }) => {
        store.advance(5000);
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return "stopped";
      },
    });
    assert.ok(supervised.started);
    assert.equal(supervised.stopReason, "ownership-lost");
    assert.equal(supervised.exitRejection, "stale-execution");
    assert.equal(store.execution(key)?.state, "running", "a non-owner never records the exit");
  });
});

test("C28: outcomes before exit, after cancel, or with unconfirmed cleanup are not accepted", async () => {
  const store = new InMemoryExecutionStore();
  const start = async () => {
    const key = operation();
    store.executingReceipt(key);
    const started = await store.start({ key, workerId: "worker-a", budgetMs: 60_000, heartbeatTtlMs: 1000 });
    assert.ok(started.ok);
    return { key, claim: { executionEpoch: started.execution.executionEpoch, workerId: "worker-a" } };
  };

  const running = await start();
  assert.deepEqual(store.publishOutcome(running.key, running.claim, "effect-published"), { ok: false, code: "process-running" });

  const cancelledAfterExit = await start();
  assert.ok((await store.recordExit(cancelledAfterExit.key, cancelledAfterExit.claim, { status: 0, cleanup: "observed" })).ok);
  assert.ok(store.requestCancel(cancelledAfterExit.key, "operator cancel").ok);
  assert.deepEqual(store.publishOutcome(cancelledAfterExit.key, cancelledAfterExit.claim, "effect-published", "diag://harness-output"),
    { ok: false, code: "late-result" });
  assert.deepEqual(store.receipt(cancelledAfterExit.key), { state: "failed", diagnostics: ["diag://harness-output"] },
    "late result fails the receipt while preserving its diagnostic");

  const cancelledThenLost = await start();
  assert.ok(store.requestCancel(cancelledThenLost.key, "operator cancel").ok);
  store.advance(1500);
  store.fenceLostExecutions();
  assert.equal(store.receipt(cancelledThenLost.key)?.state, "failed");
  assert.match(store.receipt(cancelledThenLost.key)?.diagnostics[0] ?? "", /cleanup-unconfirmed$/);
  const restart = await store.start({ key: cancelledThenLost.key, workerId: "worker-b", budgetMs: 60_000, heartbeatTtlMs: 1000 });
  assert.equal(restart.ok ? undefined : restart.code, "receipt-not-executing");

  const unconfirmed = await start();
  assert.ok((await store.recordExit(unconfirmed.key, unconfirmed.claim, { status: null, stopReason: "deadline", cleanup: "unconfirmed" })).ok);
  assert.deepEqual(store.publishOutcome(unconfirmed.key, unconfirmed.claim, "effect-published"), { ok: false, code: "cleanup-unconfirmed" });
  assert.deepEqual(store.publishOutcome(unconfirmed.key, unconfirmed.claim, "failed"), { ok: true });
  assert.deepEqual(store.requestCancel(unconfirmed.key, "too late").ok, false, "a published outcome cannot be cancelled");
});

test("C29: harnesses receive no host home, engine socket, or service credentials", async () => withScratch(async (scratch) => {
  const hostHome = join(scratch, "host-home");
  const home = await createHarnessHome(join(scratch, "harness"), { hostHome });
  const inherited = {
    PATH: process.env["PATH"],
    LANG: "C.UTF-8",
    HOME: hostHome,
    DOCKER_HOST: "unix:///var/run/docker.sock",
    CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
    XDG_RUNTIME_DIR: "/run/user/1000",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
    DAPR_API_TOKEN: "dapr-secret",
    PGPASSWORD: "pg-secret",
    GH_TOKEN: "not-bound",
  };
  const environment = buildHarnessEnvironment({ home: home.home, inherited, credentials: { GH_TOKEN: "bound-token" }, hostHome });
  assert.equal(environment["HOME"], home.home);
  assert.equal(environment["GH_TOKEN"], "bound-token");
  for (const name of ["DOCKER_HOST", "CONTAINER_HOST", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "DAPR_API_TOKEN", "PGPASSWORD"]) {
    assert.equal(environment[name], undefined, `${name} must not reach the harness`);
  }
  assert.throws(() => buildHarnessEnvironment({ home: home.home, credentials: { DOCKER_HOST: "tcp://x" }, hostHome }), /reserved/);
  assert.throws(() => buildHarnessEnvironment({ home: join(hostHome, "work"), hostHome }), /host home/);
  await assert.rejects(createHarnessHome(join(hostHome, "scratch"), { hostHome }), /host home/);

  if (posix) {
    process.env["FORGE_ISOLATION_PROBE"] = "worker-secret";
    try {
      const probe = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.FORGE_ISOLATION_PROBE ?? null, process.env.HOME]))"], {
        cwd: scratch, timeoutMs: 10_000, maxBufferBytes: 4096, ...harnessProcessOptions({ isolation: { environment } }),
      });
      assert.deepEqual(JSON.parse(probe.stdout), [null, home.home], "the worker environment is not inherited");
    } finally {
      delete process.env["FORGE_ISOLATION_PROBE"];
    }
  }

  const violations = checkContainerIsolation({
    mounts: [
      { type: "volume", source: "forge-artifacts", target: "/artifacts" },
      { type: "tmpfs", target: "/tmp" },
      { type: "bind", source: "/srv/forge/components", target: "/components", readOnly: true },
      { type: "bind", source: join(hostHome, "repo"), target: "/workspace" },
      { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
      { type: "bind", source: "/run/user/1000/podman/podman.sock", target: "/run/podman.sock" },
      { type: "bind", source: "/run/user/1000", target: "/host-runtime" },
    ],
    privileged: true,
    pid: "host",
    environment: { CONTAINER_HOST: "unix:///run/podman.sock" },
  }, { hostHome, runtimeDir: "/run/user/1000" });
  assert.deepEqual(violations.map((violation) => violation.code), [
    "host-home-mount",
    "engine-socket-mount",
    "engine-socket-mount",
    "engine-socket-mount",
    "privileged",
    "host-pid",
    "engine-endpoint-env",
  ]);
}));
