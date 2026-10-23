import type {
  HostRunnerJobSummaryListV1,
  HostRunnerJobSummaryV1,
} from "../storage/postgres/host-runner-jobs.ts";
import type { RunServiceResult } from "./runs.ts";

const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function publicSummary(job: HostRunnerJobSummaryV1): HostRunnerJobSummaryV1 {
  return {
    operationId: job.operationId,
    runId: job.runId,
    taskId: job.taskId,
    repositoryId: job.repositoryId,
    harness: job.harness,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
  };
}

export interface HostRunnerSummaryReader {
  listSummaries(repositoryId?: string): Promise<HostRunnerJobSummaryListV1>;
}

/** Operator-facing read model; it never exposes runner capabilities or job payloads. */
export class HostRunnerMonitor {
  constructor(private readonly jobs: HostRunnerSummaryReader) {}

  async list(repositoryId?: string): Promise<RunServiceResult> {
    if (repositoryId !== undefined && !REPOSITORY_ID.test(repositoryId)) {
      return { ok: false, status: 400, code: "invalid-request", detail: "repositoryId is invalid" };
    }
    const summaries = await this.jobs.listSummaries(repositoryId);
    return {
      ok: true,
      status: 200,
      body: {
        jobs: summaries.jobs.map(publicSummary),
        activeTruncated: summaries.activeTruncated,
      },
    };
  }
}
