import { getRuntimeDataDir, readRuntimeApiAccess } from "../runtime.ts";
import { ServiceApiError, ServiceClient, type HostRunnerJobSummary, type HostRunnerJobsResponse as ServiceHostRunnerJobsResponse } from "../service-client.ts";

const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_STATES: readonly HostRunnerJobSummary["state"][] = ["queued", "leased", "completed", "failed", "cancelled"];
const MAX_SUMMARIES = 120;

export interface HostRunnerJobsDeps {
  client(): Promise<{
    hostRunnerJobs(repositoryId?: string): Promise<unknown>;
  }>;
}

export function defaultHostRunnerJobsDeps(): HostRunnerJobsDeps {
  return {
    async client() {
      const access = await readRuntimeApiAccess();
      return new ServiceClient(access.baseUrl, access.token);
    },
  };
}

export interface HostRunnerJobsResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function failure(error: unknown): HostRunnerJobsResponse {
  if (error instanceof ServiceApiError) {
    return {
      status: error.status === 0 ? 503 : error.status,
      body: { ok: false, code: error.code, message: error.message },
    };
  }
  return {
    status: 503,
    body: {
      ok: false,
      code: "service-unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJobState(value: unknown): value is HostRunnerJobSummary["state"] {
  return typeof value === "string" && JOB_STATES.some((state) => state === value);
}

function invalidResponse(): ServiceApiError {
  return new ServiceApiError(502, "invalid-response", "The local service returned invalid host-runner job summaries.");
}

function parseJob(value: unknown): HostRunnerJobSummary {
  if (!isRecord(value)
    || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)
    || typeof value.runId !== "string" || !/^run_[A-Za-z0-9_-]{1,128}$/.test(value.runId)
    || typeof value.taskId !== "string" || value.taskId.length === 0 || value.taskId.length > 200
    || typeof value.repositoryId !== "string" || !REPOSITORY_ID.test(value.repositoryId)
    || typeof value.harness !== "string" || value.harness.length === 0 || value.harness.length > 80
    || !isJobState(value.state)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.leaseExpiresAt !== undefined
      && (typeof value.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(value.leaseExpiresAt))))) {
    throw invalidResponse();
  }
  return {
    operationId: value.operationId,
    runId: value.runId,
    taskId: value.taskId,
    repositoryId: value.repositoryId,
    harness: value.harness,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.leaseExpiresAt === "string" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
  };
}

function parseSummaries(value: unknown): ServiceHostRunnerJobsResponse {
  if (!isRecord(value)
    || typeof value.activeTruncated !== "boolean"
    || !Array.isArray(value.jobs)
    || value.jobs.length > MAX_SUMMARIES) {
    throw invalidResponse();
  }
  return {
    jobs: value.jobs.map(parseJob),
    activeTruncated: value.activeTruncated,
  };
}

/** Lists the service's safe, bounded queue summaries for the local operator. */
export async function listHostRunnerJobs(
  deps: HostRunnerJobsDeps,
  repositoryId: unknown,
): Promise<HostRunnerJobsResponse> {
  if (repositoryId !== undefined && (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId))) {
    return {
      status: 400,
      body: { ok: false, code: "invalid-repository", message: "A valid repository ID is required." },
    };
  }
  try {
    const result = parseSummaries(await (await deps.client()).hostRunnerJobs(repositoryId));
    return { status: 200, body: { ok: true, available: true, ...result } };
  } catch (error) {
    return failure(error);
  }
}
