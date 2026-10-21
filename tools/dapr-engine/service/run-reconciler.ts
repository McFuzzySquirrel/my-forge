import type { RunLifecycleEventInputV1 } from "../contract/v1/index.ts";

export interface OrchestrationFailureV1 {
  readonly runtimeStatus: "FAILED" | "TERMINATED";
  readonly message?: string;
}

export interface RunReconcilerDependencies {
  /** Runs whose projected status is not terminal. */
  listActiveRunIds(): Promise<readonly string[]>;
  /** The run's orchestration failure, or undefined while it is running, completed, or missing. */
  orchestrationFailure(runId: string): Promise<OrchestrationFailureV1 | undefined>;
  appendEvent(input: RunLifecycleEventInputV1): Promise<unknown>;
}

export const ORCHESTRATION_FAILED_EVENT_KEY = "run.orchestration-failed";
const MAX_MESSAGE_LENGTH = 500;

/**
 * A run orchestration that fails or is terminated cannot record its own
 * terminal status. Without this, its projection stays non-terminal forever and
 * its repository leases stay held.
 */
export async function reconcileFailedRuns(
  dependencies: RunReconcilerDependencies,
  onError: (runId: string, error: unknown) => void,
): Promise<number> {
  let reconciled = 0;
  for (const runId of await dependencies.listActiveRunIds()) {
    try {
      const failure = await dependencies.orchestrationFailure(runId);
      if (!failure) continue;
      await dependencies.appendEvent({
        schemaVersion: 1,
        runId,
        eventKey: ORCHESTRATION_FAILED_EVENT_KEY,
        eventType: "run.failed",
        runStatus: "failed",
        detail: {
          reason: "orchestration-failed",
          runtimeStatus: failure.runtimeStatus,
          ...(failure.message ? { message: failure.message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
        },
      });
      reconciled += 1;
    } catch (error) {
      onError(runId, error);
    }
  }
  return reconciled;
}
