// ─── Console access to local execution-service runs ─────────────────────────
//
// The Console reaches the service API with the installation token from
// runtime.env, so the browser never holds that token. Every request is scoped
// to the repository currently open in the Console: runs that belong to another
// registered repository are reported as unknown.

import { getRuntimeDataDir, readRuntimeApiAccess } from "../runtime.ts";
import { findRegisteredRepository } from "../runtime-repositories.ts";
import { CONTROL_ACTIONS, ServiceApiError, ServiceClient } from "../service-client.ts";

export interface ServiceRunsDeps {
  client(): Promise<Pick<ServiceClient, "list" | "get" | "events" | "control">>;
  repositoryId(repoRoot: string): Promise<string | undefined>;
}

export function defaultServiceRunsDeps(): ServiceRunsDeps {
  return {
    async client() {
      const access = await readRuntimeApiAccess();
      return new ServiceClient(access.baseUrl, access.token);
    },
    async repositoryId(repoRoot) {
      return (await findRegisteredRepository(getRuntimeDataDir(), repoRoot))?.id;
    },
  };
}

export interface ServiceResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const RUN_ID = /^run_[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^\S{1,200}$/;

function failure(error: unknown): ServiceResponse {
  if (error instanceof ServiceApiError) {
    return { status: error.status === 0 ? 503 : error.status, body: { ok: false, code: error.code, message: error.message } };
  }
  return { status: 503, body: { ok: false, code: "service-unavailable", message: error instanceof Error ? error.message : String(error) } };
}

async function scope(deps: ServiceRunsDeps, repoRoot: string | null): Promise<string | ServiceResponse> {
  if (!repoRoot) return { status: 400, body: { ok: false, code: "no-repo", message: "No repository is selected." } };
  try {
    const repositoryId = await deps.repositoryId(repoRoot);
    if (repositoryId) return repositoryId;
  } catch (error) {
    return failure(error);
  }
  return {
    status: 200,
    body: {
      ok: true,
      available: false,
      reason: "not-registered",
      message: `This repository is not registered with the local runtime. Run "forge-launcher runtime repo add ${repoRoot}", ` +
        "then restart the runtime.",
      runs: [],
    },
  };
}

/** Lists the current repository's service runs, or explains why none can be shown. */
export async function listServiceRuns(deps: ServiceRunsDeps, repoRoot: string | null): Promise<ServiceResponse> {
  const repositoryId = await scope(deps, repoRoot);
  if (typeof repositoryId !== "string") return repositoryId;
  try {
    const { runs } = await (await deps.client()).list(repositoryId);
    return { status: 200, body: { ok: true, available: true, repositoryId, runs } };
  } catch (error) {
    const response = failure(error);
    return { status: 200, body: { ...response.body, ok: true, available: false, reason: "unavailable", runs: [] } };
  }
}

/** Returns the newest owned service run with its current task-status snapshot. */
export async function latestServiceRun(deps: ServiceRunsDeps, repoRoot: string | null): Promise<ServiceResponse> {
  const repositoryId = await scope(deps, repoRoot);
  if (typeof repositoryId !== "string") return repositoryId;
  try {
    const client = await deps.client();
    const { runs } = await client.list(repositoryId);
    const latest = newestFirst(runs)[0];
    if (!latest) return { status: 200, body: { ok: true, available: true, run: null } };
    if (typeof latest.runId !== "string" || !RUN_ID.test(latest.runId)) {
      return { status: 503, body: { ok: false, code: "invalid-run", message: "The service returned a run without a valid id." } };
    }
    const run = await client.get(latest.runId);
    if (run.repositoryId !== repositoryId) {
      return { status: 404, body: { ok: false, code: "unknown-run", message: `Run '${latest.runId}' does not belong to this repository.` } };
    }
    return { status: 200, body: { ok: true, available: true, run } };
  } catch (error) {
    return failure(error);
  }
}

async function ownedRun(
  deps: ServiceRunsDeps,
  repoRoot: string | null,
  runId: unknown,
): Promise<{ client: Awaited<ReturnType<ServiceRunsDeps["client"]>>; run: Record<string, unknown> } | ServiceResponse> {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    return { status: 400, body: { ok: false, code: "invalid-run", message: "A valid run id is required." } };
  }
  const repositoryId = await scope(deps, repoRoot);
  if (typeof repositoryId !== "string") {
    return repositoryId.status === 200
      ? { status: 409, body: { ...repositoryId.body, ok: false } }
      : repositoryId;
  }
  try {
    const client = await deps.client();
    const run = await client.get(runId);
    if (run.repositoryId !== repositoryId) {
      return { status: 404, body: { ok: false, code: "unknown-run", message: `Run '${runId}' does not belong to this repository.` } };
    }
    return { client, run };
  } catch (error) {
    return failure(error);
  }
}

/** Returns a run and its events after `after`, for sequenced reconnects. */
export async function serviceRunDetail(
  deps: ServiceRunsDeps,
  repoRoot: string | null,
  runId: unknown,
  after: unknown,
): Promise<ServiceResponse> {
  const cursor = typeof after === "string" && /^\d+$/.test(after) ? Number(after) : 0;
  const owned = await ownedRun(deps, repoRoot, runId);
  if ("status" in owned && "body" in owned) return owned;
  try {
    const page = await owned.client.events(runId as string, cursor);
    return { status: 200, body: { ok: true, run: owned.run, events: page.events, cursor: page.cursor, hasMore: page.hasMore } };
  } catch (error) {
    return failure(error);
  }
}

/** Submits an acknowledged control for a run owned by the current repository. */
export async function controlServiceRun(
  deps: ServiceRunsDeps,
  repoRoot: string | null,
  body: Record<string, unknown>,
): Promise<ServiceResponse> {
  const { runId, action, taskId } = body;
  if (typeof action !== "string" || !CONTROL_ACTIONS.has(action)) {
    return { status: 400, body: { ok: false, code: "invalid-action", message: "Unknown control action." } };
  }
  const needsTask = action === "replay-task" || action === "approve-task";
  if (needsTask && (typeof taskId !== "string" || !TASK_ID.test(taskId))) {
    return { status: 400, body: { ok: false, code: "unknown-task", message: `${action} requires a task id.` } };
  }
  const owned = await ownedRun(deps, repoRoot, runId);
  if ("status" in owned && "body" in owned) return owned;
  try {
    const result = await owned.client.control(runId as string, action, needsTask ? { taskId } : {});
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    return failure(error);
  }
}

export type RoutedConsoleAction = "pause" | "stop" | "replay" | "approve";

function newestFirst(runs: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return [...runs].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

const ACTIVE_STATUSES = new Set(["queued", "running", "pausing", "paused", "stopping", "cancelling"]);

/**
 * Routes a Console build control to the repository's service run. Unregistered
 * repositories fail closed instead of using legacy file/PID controls.
 *
 * pause/stop and approve target the newest active run; replay targets the
 * newest run, which the service reopens if it already finished.
 */
export async function routeServiceControl(
  deps: ServiceRunsDeps,
  repoRoot: string | null,
  action: RoutedConsoleAction,
  taskId?: string,
): Promise<ServiceResponse> {
  const repositoryId = await scope(deps, repoRoot);
  if (typeof repositoryId !== "string") {
    if (repositoryId.status !== 200) return repositoryId;
    return {
      status: 409,
      body: {
        ...repositoryId.body,
        ok: false,
        code: "service-required",
        message: `${String(repositoryId.body.message ?? "Repository is not registered.")} Legacy controls are retired.`,
      },
    };
  }
  const needsTask = action === "replay" || action === "approve";
  if (needsTask && (typeof taskId !== "string" || !TASK_ID.test(taskId))) {
    return { status: 400, body: { ok: false, code: "unknown-task", message: `${action} requires a task id.` } };
  }
  try {
    const client = await deps.client();
    const runs = newestFirst((await client.list(repositoryId)).runs);
    const run = action === "replay" ? runs[0] : runs.find((entry) => ACTIVE_STATUSES.has(String(entry.status)));
    if (!run) {
      return {
        status: 409,
        body: { ok: false, code: "no-active-run", message: action === "replay" ? "This repository has no service runs to replay." : "No active service run for this repository." },
      };
    }
    const runId = String(run.runId);
    const serviceAction = action === "replay" ? "replay-task" : action === "approve" ? "approve-task" : action;
    const result = await client.control(runId, serviceAction, needsTask ? { taskId } : {});
    const messages: Record<RoutedConsoleAction, string> = {
      pause: `Pause requested for service run ${runId}; it pauses after the current task.`,
      stop: `Stop requested for service run ${runId}; it stops after the current task and can be resumed.`,
      replay: `Replay of ${taskId} requested for service run ${runId}.`,
      approve: `Human review of ${taskId} approved for service run ${runId}; the run continues.`,
    };
    return { status: 200, body: { ok: true, message: messages[action], runId, ...result } };
  } catch (error) {
    return failure(error);
  }
}
