import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import { HostRunnerWorker } from "../../execution/host-runner-worker.ts";
import type { HostRunnerClaimV1, HostRunnerClient } from "../../execution/host-runner-client.ts";
import type { HarnessRunner, HarnessRunnerResultV1 } from "../../execution/runner-contract.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

const operationId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "repo_test";
const capability = "x".repeat(43);
const request: HostRunnerClaimV1["request"] = {
  schemaVersion: 1,
  identity: {
    runId: `run_${"a".repeat(32)}`,
    taskId: "T1",
    manifestDigest: `sha256:${"b".repeat(64)}`,
    logicalAttempt: 1,
    operationId,
  },
  repositoryId,
  baseRevision: "a".repeat(40),
  harness: "stub",
  agent: agent("builder"),
  task: manifestTask({ id: "T1", ownerAgent: "builder" }),
  contextBlock: "",
  requiredCapabilities: ["repository-tools"],
  timeoutMs: 10_000,
  instructions: "Complete the task.",
};
const claim: HostRunnerClaimV1 = { leaseId, request };
const result: HarnessRunnerResultV1 = {
  schemaVersion: 1,
  identity: request.identity,
  result: { success: true, outputFiles: [], stdout: "", stderr: "", durationMs: 1 },
  workspaceDelta: {
    format: "git-binary-diff-v1",
    baseRevision: request.baseRevision,
    digest: sha256Digest(Buffer.alloc(0)),
    contentBase64: "",
  },
};

describe("HostRunnerWorker", () => {
  it("executes a claim, monitors its lease, and submits the result", async () => {
    let claimed = false;
    let completed: HarnessRunnerResultV1 | undefined;
    let heartbeats = 0;
    const client: HostRunnerClient = {
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return claim;
      },
      async heartbeat() { heartbeats++; return true; },
      async get() { return { state: "leased", cancelRequested: false }; },
      async complete(_repository, _capability, _operation, _lease, value) { completed = value; },
      async fail() { assert.fail("unexpected failure"); },
    };
    const runner: HarnessRunner = { async run() { return result; } };
    const shutdown = new AbortController();
    const worker = new HostRunnerWorker({
      client,
      runner,
      repositories: [{ repositoryId, capability }],
    });
    const running = worker.run(shutdown.signal);
    while (!completed) await delay(5);
    shutdown.abort();
    await running;
    assert.deepEqual(completed, result);
    assert.equal(heartbeats, 0);
  });

  it("aborts work on a cancellation request without submitting a result", async () => {
    let claimed = false;
    let cancelled = false;
    let completed = false;
    const shutdown = new AbortController();
    const client: HostRunnerClient = {
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return claim;
      },
      async heartbeat() { return true; },
      async get() {
        cancelled = true;
        shutdown.abort();
        return { state: "leased", cancelRequested: true };
      },
      async complete() { completed = true; },
      async fail() { assert.fail("unexpected failure"); },
    };
    const runner: HarnessRunner = {
      async run(_request, signal) {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return result;
      },
    };
    const worker = new HostRunnerWorker({
      client,
      runner,
      repositories: [{ repositoryId, capability }],
    });
    await worker.run(shutdown.signal);
    assert.equal(cancelled, true);
    assert.equal(completed, false);
  });
});
