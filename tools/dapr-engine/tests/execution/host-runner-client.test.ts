import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import { HostRunnerHttpClient } from "../../execution/host-runner-client.ts";
import type { HarnessRunnerRequestV1, HarnessRunnerResultV1 } from "../../execution/runner-contract.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

const repositoryId = "repo_test";
const capability = "x".repeat(43);
const operationId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const request: HarnessRunnerRequestV1 = {
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

describe("HostRunnerHttpClient", () => {
  it("uses loopback authentication headers and validates host-runner responses", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const responses = [
      { ready: true },
      { claim: { leaseId, request } },
      { renewed: true },
      { state: "leased", cancelRequested: false },
      { accepted: true },
      { accepted: true },
    ];
    const client = new HostRunnerHttpClient({
      baseUrl: "http://127.0.0.1:8483",
      apiToken: "runtime-api-token-long-enough-for-validation",
      fetch: async (input, init = {}) => {
        calls.push({ url: new URL(String(input)), init });
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      },
    });

    assert.equal(await client.ready(), true);
    assert.deepEqual(await client.claim(repositoryId, capability), { leaseId, request });
    assert.equal(await client.heartbeat(repositoryId, capability, operationId, leaseId), true);
    assert.deepEqual(await client.get(repositoryId, capability, operationId, leaseId), {
      state: "leased",
      cancelRequested: false,
    });
    await client.complete(repositoryId, capability, operationId, leaseId, result);
    await client.fail(repositoryId, capability, operationId, leaseId, "failed");

    assert.equal(calls.length, 6);
    for (const { url, init } of calls) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer runtime-api-token-long-enough-for-validation");
      assert.equal(headers.get("x-forge-runner-capability"), url.pathname === "/health/ready" ? null : capability);
    }
    assert.equal(calls[0]!.url.pathname, "/health/ready");
    assert.equal(calls[1]!.url.pathname, "/v1/host-runner/jobs/claim");
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { repositoryId });
    assert.equal(calls[3]!.url.searchParams.get("repositoryId"), repositoryId);
    assert.equal(calls[3]!.url.searchParams.get("leaseId"), leaseId);
    assert.ok(calls.every(({ init }) => !String(init.body).includes(capability)));
  });

  it("rejects non-loopback service URLs", () => {
    assert.throws(
      () => new HostRunnerHttpClient({ baseUrl: "http://example.invalid", apiToken: "x".repeat(40) }),
      /loopback/,
    );
  });
});
