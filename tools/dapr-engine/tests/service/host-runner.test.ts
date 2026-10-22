import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import type { HarnessRunnerResultV1 } from "../../execution/runner-contract.ts";
import {
  HostRunnerService,
  parseHostRunnerCapabilityHashes,
  type HostRunnerJobStore,
} from "../../service/host-runner.ts";
import type {
  HostRunnerClaimV1,
  HostRunnerJobV1,
} from "../../storage/postgres/host-runner-jobs.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

const repositoryId = "repo_demo";
const capability = "c".repeat(43);
const operationId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
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

class FakeJobs implements HostRunnerJobStore {
  claimCalls = 0;
  cancelCalls = 0;
  completeCalls = 0;
  job: HostRunnerJobV1 | undefined = {
    request,
    state: "leased",
    leaseId,
    cancelRequested: false,
  };

  async claim(): Promise<HostRunnerClaimV1> {
    this.claimCalls++;
    return { leaseId, request };
  }
  async heartbeat(): Promise<boolean> { return true; }
  async getForRunner(): Promise<HostRunnerJobV1 | undefined> { return this.job; }
  async complete(): Promise<boolean> { this.completeCalls++; return true; }
  async fail(): Promise<boolean> { return true; }
  async cancel(): Promise<boolean> { this.cancelCalls++; return true; }
}

function capabilityHashes(): Map<string, string> {
  return new Map([[repositoryId, `sha256:${createHash("sha256").update(capability).digest("hex")}`]]);
}

function result(): HarnessRunnerResultV1 {
  return {
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
}

describe("HostRunnerService", () => {
  it("authenticates capabilities per repository and rejects revoked credentials", async () => {
    const jobs = new FakeJobs();
    const service = new HostRunnerService({ jobs, capabilityHashes: capabilityHashes() });

    const otherRepository = await service.claim("repo_other", capability);
    assert.equal(otherRepository.ok, false);
    if (!otherRepository.ok) assert.equal(otherRepository.status, 403);
    assert.equal(jobs.claimCalls, 0);

    const invalid = await service.claim(repositoryId, "x".repeat(43));
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.status, 403);

    const accepted = await service.claim(repositoryId, capability);
    assert.equal(accepted.ok, true);
    assert.equal(jobs.claimCalls, 1);

    const revoked = new HostRunnerService({ jobs, capabilityHashes: new Map() });
    const rejected = await revoked.claim(repositoryId, capability);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.status, 403);
  });

  it("fences stale leases and rejects cancelled or malformed results", async () => {
    const jobs = new FakeJobs();
    const service = new HostRunnerService({ jobs, capabilityHashes: capabilityHashes() });
    jobs.job = undefined;
    const stale = await service.get(repositoryId, operationId, leaseId, capability);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.status, 404);

    jobs.job = { request, state: "leased", leaseId, cancelRequested: true };
    const cancelled = await service.complete(repositoryId, operationId, leaseId, capability, result());
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.status, 409);
    assert.equal(jobs.cancelCalls, 1);

    jobs.job = { request, state: "leased", leaseId, cancelRequested: false };
    const malformed = await service.complete(repositoryId, operationId, leaseId, capability, { schemaVersion: 99 });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.status, 422);
    assert.equal(jobs.completeCalls, 0);
  });

  it("parses only hashed capability values", () => {
    const parsed = parseHostRunnerCapabilityHashes({
      version: 1,
      capabilities: { [repositoryId]: capabilityHashes().get(repositoryId) },
    });
    assert.equal(parsed.get(repositoryId), capabilityHashes().get(repositoryId));
    assert.throws(() => parseHostRunnerCapabilityHashes({
      version: 1,
      capabilities: { [repositoryId]: capability },
    }), /invalid entry/);
  });
});
