import { setTimeout as delay } from "node:timers/promises";
import { parseHarnessRunnerRequest, parseHarnessRunnerResult } from "./runner-contract.ts";
import type {
  HarnessRunner,
  HarnessRunnerRequestV1,
  HarnessRunnerResultV1,
} from "./runner-contract.ts";
import { DEFAULT_MAX_WORKSPACE_DELTA_BYTES } from "./workspace-diff.ts";
import type { PostgresHostRunnerJobStore } from "../storage/postgres/host-runner-jobs.ts";

const POLL_INTERVAL_MS = 250;
const CANCELLATION_GRACE_MS = 5_000;

/** Dapr-side durable queue adapter. Dapr remains responsible for retry policy. */
export class QueuedHarnessRunner implements HarnessRunner {
  constructor(
    private readonly jobs: PostgresHostRunnerJobStore,
    private readonly maxResultBytes = DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
  ) {}

  async run(
    request: HarnessRunnerRequestV1,
    signal?: AbortSignal,
  ): Promise<HarnessRunnerResultV1> {
    const validated = parseHarnessRunnerRequest(request);
    signal?.throwIfAborted();
    const enqueued = await this.jobs.enqueue(validated);
    if (!enqueued.ok) {
      throw new Error(`Host-runner operation '${validated.identity.operationId}' was reused with different request data.`);
    }
    const operationId = validated.identity.operationId;
    let cancelPromise: Promise<void> | undefined;
    const cancel = () => {
      cancelPromise = this.jobs.cancel(operationId).then(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const deadline = Date.now() + validated.timeoutMs + CANCELLATION_GRACE_MS;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const job = await this.jobs.get(operationId);
        if (!job) throw new Error(`Host-runner operation '${operationId}' disappeared from durable storage.`);
        if (job.state === "completed") {
          return parseHarnessRunnerResult(validated, job.result, this.maxResultBytes);
        }
        if (job.state === "failed") {
          throw new Error(job.errorMessage || "The host runner failed without an error description.");
        }
        if (job.state === "cancelled") {
          throw new DOMException("The host-runner operation was cancelled.", "AbortError");
        }
        await delay(POLL_INTERVAL_MS, undefined, signal ? { signal } : undefined);
      }
      await this.jobs.cancel(operationId);
      throw new Error(`Host-runner operation '${operationId}' exceeded its execution deadline.`);
    } catch (error) {
      if (signal?.aborted) {
        cancel();
        await cancelPromise;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}
