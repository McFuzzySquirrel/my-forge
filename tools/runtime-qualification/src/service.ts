import { readRuntimeApiAccess } from "../../../scripts/forge-launcher/scripts/runtime.ts";
import {
  repositoryIdFor,
  ServiceApiError,
  ServiceClient,
  submitRepositoryRun,
  TERMINAL_STATUSES,
} from "../../../scripts/forge-launcher/scripts/service-client.ts";
import { sleep, waitFor } from "./support.ts";

export { ServiceApiError, ServiceClient };

export interface TaskState {
  readonly taskId: string;
  readonly status: string;
  readonly logicalAttempt?: number;
  readonly [key: string]: unknown;
}

export interface RunState {
  readonly runId: string;
  readonly status: string;
  readonly tasks: readonly TaskState[];
  readonly [key: string]: unknown;
}

export async function connect(): Promise<ServiceClient> {
  const access = await readRuntimeApiAccess();
  return new ServiceClient(access.baseUrl, access.token);
}

/** Waits until the service answers authenticated requests. */
export async function waitForApi(client: ServiceClient, timeoutMs = 180_000): Promise<number> {
  const started = Date.now();
  await waitFor("service API", async () => (await client.list()).runs !== undefined, timeoutMs, 1_000);
  return Date.now() - started;
}

export interface SubmitOptions {
  readonly key?: string;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly concurrency?: number;
  readonly tasks?: readonly string[];
}

export async function submit(client: ServiceClient, repoRoot: string, options: SubmitOptions = {}) {
  const settings: Record<string, number | boolean> = { allowNoop: true };
  if (options.maxRetries !== undefined) settings.maxRetries = options.maxRetries;
  if (options.retryDelayMs !== undefined) settings.retryDelayMs = options.retryDelayMs;
  if (options.concurrency !== undefined) settings.concurrency = options.concurrency;
  return submitRepositoryRun(client, {
    repoRoot,
    repositoryId: await repositoryIdFor(repoRoot),
    harness: "stub",
    settings,
    requestedTaskIds: [...(options.tasks ?? [])],
    ...(options.key ? { submissionKey: options.key } : {}),
  }, () => undefined);
}

export async function runState(client: ServiceClient, runId: string): Promise<RunState> {
  return await client.get(runId) as unknown as RunState;
}

export function taskStatus(run: RunState, taskId: string): string | undefined {
  return run.tasks.find((task) => task.taskId === taskId)?.status;
}

export async function waitForTaskStatus(
  client: ServiceClient,
  runId: string,
  taskId: string,
  statuses: readonly string[],
  timeoutMs: number,
): Promise<RunState> {
  return waitFor(`${runId} ${taskId} in ${statuses.join("/")}`, async () => {
    const run = await runState(client, runId);
    const status = taskStatus(run, taskId);
    if (TERMINAL_STATUSES.has(run.status) && !statuses.includes(status ?? "")) {
      throw new Error(`run ended ${run.status} with ${taskId}=${status}`);
    }
    return status && statuses.includes(status) ? run : undefined;
  }, timeoutMs, 1_000);
}

export async function waitForTerminal(client: ServiceClient, runId: string, timeoutMs: number): Promise<RunState> {
  return waitFor(`${runId} to finish`, async () => {
    const run = await runState(client, runId);
    return TERMINAL_STATUSES.has(run.status) ? run : undefined;
  }, timeoutMs, 1_000);
}

export async function allEvents(client: ServiceClient, runId: string): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const page = await client.events(runId, cursor, 500);
    events.push(...page.events);
    cursor = page.cursor;
    if (!page.hasMore) return events;
  }
}

/** Calls the API, returning the HTTP status and error code rather than throwing. */
export async function attempt<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; status: number; code: string }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof ServiceApiError) return { ok: false, status: error.status, code: error.code };
    throw error;
  }
}

/** Retries calls that fail only because the service is restarting. */
export async function whenReachable<T>(call: () => Promise<T>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ServiceApiError) || (error.status !== 0 && error.status < 500) || Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
}
