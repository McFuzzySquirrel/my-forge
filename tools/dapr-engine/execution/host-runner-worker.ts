import { setTimeout as delay } from "node:timers/promises";
import type { HarnessRunner } from "./runner-contract.ts";
import type {
  HostRunnerClaimV1,
  HostRunnerClient,
} from "./host-runner-client.ts";

const EMPTY_QUEUE_DELAY_MS = 1_000;
const STATUS_POLL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 8_000;

export interface HostRunnerCredentialV1 {
  readonly repositoryId: string;
  readonly capability: string;
}

export interface HostRunnerWorkerOptions {
  readonly client: HostRunnerClient;
  readonly runner: HarnessRunner;
  readonly repositories: readonly HostRunnerCredentialV1[];
  readonly onError?: (error: unknown) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Polls each registered project independently and keeps every execution lease alive. */
export class HostRunnerWorker {
  constructor(private readonly options: HostRunnerWorkerOptions) {}

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.options.repositories.map((repository) => this.poll(repository, signal)));
  }

  private async poll(repository: HostRunnerCredentialV1, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const claim = await this.options.client.claim(repository.repositoryId, repository.capability);
        if (claim) {
          await this.execute(repository, claim, signal);
          continue;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.options.onError?.(error);
      }
      try {
        await delay(EMPTY_QUEUE_DELAY_MS, undefined, { signal });
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
    }
  }

  private async execute(
    repository: HostRunnerCredentialV1,
    claim: HostRunnerClaimV1,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const { operationId } = claim.request.identity;
    const work = new AbortController();
    const monitorStop = new AbortController();
    const abortWork = () => {
      work.abort();
      monitorStop.abort();
    };
    shutdownSignal.addEventListener("abort", abortWork, { once: true });
    let leaseError: unknown;
    const monitoring = this.monitorLease(
      repository,
      claim,
      work,
      monitorStop.signal,
    ).catch((error: unknown) => {
      if (!monitorStop.signal.aborted) {
        leaseError = error;
        work.abort(error);
      }
    });

    try {
      const result = await this.options.runner.run(claim.request, work.signal);
      work.signal.throwIfAborted();
      if (leaseError) throw leaseError;
      monitorStop.abort();
      await monitoring;
      if (!shutdownSignal.aborted) {
        await this.options.client.complete(
          repository.repositoryId,
          repository.capability,
          operationId,
          claim.leaseId,
          result,
        );
      }
    } catch (error) {
      monitorStop.abort();
      await monitoring;
      if (shutdownSignal.aborted || isAbortError(error) || leaseError) return;
      await this.options.client.fail(
        repository.repositoryId,
        repository.capability,
        operationId,
        claim.leaseId,
        "The native harness execution failed on the host.",
      );
    } finally {
      monitorStop.abort();
      shutdownSignal.removeEventListener("abort", abortWork);
    }
  }

  private async monitorLease(
    repository: HostRunnerCredentialV1,
    claim: HostRunnerClaimV1,
    work: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    let lastHeartbeat = Date.now();
    while (!signal.aborted) {
      await delay(STATUS_POLL_MS, undefined, { signal });
      const status = await this.options.client.get(
        repository.repositoryId,
        repository.capability,
        claim.request.identity.operationId,
        claim.leaseId,
      );
      if (!status || status.cancelRequested) {
        work.abort();
        return;
      }
      if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        const renewed = await this.options.client.heartbeat(
          repository.repositoryId,
          repository.capability,
          claim.request.identity.operationId,
          claim.leaseId,
        );
        if (!renewed) throw new Error("Host-runner lease was lost.");
        lastHeartbeat = Date.now();
      }
    }
  }
}
