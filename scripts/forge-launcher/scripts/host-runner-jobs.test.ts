import assert from "node:assert/strict";
import test from "node:test";
import { listHostRunnerJobs, type HostRunnerJobsDeps } from "./console/host-runner-jobs.ts";

test("host-runner job proxy validates repository filters before querying", async () => {
  let queried = false;
  const deps: HostRunnerJobsDeps = {
    async client() {
      return {
        async hostRunnerJobs() {
          queried = true;
          return { jobs: [], activeTruncated: false };
        },
      };
    },
  };

  const response = await listHostRunnerJobs(deps, "../other-project");

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid-repository");
  assert.equal(queried, false);
});

test("host-runner job proxy forwards only the bounded monitor response", async () => {
  const job = {
    operationId: "a03c5c7a-989f-4cb1-bad8-84ca4ae777c4",
    runId: "run_example",
    taskId: "task_example",
    repositoryId: "repo_example",
    harness: "opencode",
    state: "leased" as const,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:01:00.000Z",
  };
  const contaminatedJob = Object.assign({}, job, {
    request: { secret: "must-not-leak" },
    result: { raw: "cli output" },
    errorMessage: "private provider error",
  });
  let repositoryFilter: string | undefined;
  const deps: HostRunnerJobsDeps = {
    async client() {
      return {
        async hostRunnerJobs(repositoryId?: string) {
          repositoryFilter = repositoryId;
          return { jobs: [contaminatedJob], activeTruncated: true };
        },
      };
    },
  };

  const response = await listHostRunnerJobs(deps, "repo_example");

  assert.equal(repositoryFilter, "repo_example");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    available: true,
    jobs: [job],
    activeTruncated: true,
  });
});

test("host-runner job proxy rejects malformed service summaries", async () => {
  const deps: HostRunnerJobsDeps = {
    async client() {
      return {
        async hostRunnerJobs() {
          return { jobs: [{ state: "failed", errorMessage: "private details" }], activeTruncated: false };
        },
      };
    },
  };

  const response = await listHostRunnerJobs(deps, undefined);

  assert.equal(response.status, 502);
  assert.equal(response.body.code, "invalid-response");
});
