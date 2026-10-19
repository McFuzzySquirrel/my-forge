import { MAX_WORKER_TASK_ATTEMPTS } from "./limits.ts";

export type RunAdmissionResultV1 =
  | { readonly ok: true; readonly runId: string; readonly reserved: number; readonly available: number }
  | {
    readonly ok: false;
    readonly code: "worker-capacity-exhausted";
    readonly requested: number;
    readonly available: number;
  };

export interface RunAdmissionSnapshotV1 {
  readonly maxActiveTaskAttempts: number;
  readonly reserved: number;
  readonly available: number;
  readonly admittedRuns: number;
}

/**
 * Worker-level backpressure: a run is scheduled only after its planned
 * concurrency is reserved, so the sum of concurrently executing task attempts
 * never fills the Dapr SDK work-item slots that orchestrations need. A queued
 * activity still occupies a slot, so limiting inside the activity is not
 * enough; admission must happen before the workflow starts. Rejected runs are
 * retried by the caller later rather than queued in the SDK.
 */
export class RunAdmissionController {
  private readonly reservations = new Map<string, number>();
  readonly maxActiveTaskAttempts: number;

  constructor(maxActiveTaskAttempts: number = MAX_WORKER_TASK_ATTEMPTS) {
    if (!Number.isSafeInteger(maxActiveTaskAttempts) || maxActiveTaskAttempts < 1
      || maxActiveTaskAttempts > MAX_WORKER_TASK_ATTEMPTS) {
      throw new RangeError(`maxActiveTaskAttempts must be an integer from 1 to ${MAX_WORKER_TASK_ATTEMPTS}`);
    }
    this.maxActiveTaskAttempts = maxActiveTaskAttempts;
  }

  private reserved(): number {
    let total = 0;
    for (const value of this.reservations.values()) total += value;
    return total;
  }

  /** Idempotent per run; a different concurrency for an admitted run is a caller error. */
  reserve(runId: string, concurrency: number): RunAdmissionResultV1 {
    if (!runId) throw new TypeError("runId is required");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    const existing = this.reservations.get(runId);
    if (existing !== undefined) {
      if (existing !== concurrency) throw new Error(`Run '${runId}' is already admitted with concurrency ${existing}`);
      return { ok: true, runId, reserved: existing, available: this.maxActiveTaskAttempts - this.reserved() };
    }
    const available = this.maxActiveTaskAttempts - this.reserved();
    if (concurrency > available) {
      return { ok: false, code: "worker-capacity-exhausted", requested: concurrency, available };
    }
    this.reservations.set(runId, concurrency);
    return { ok: true, runId, reserved: concurrency, available: available - concurrency };
  }

  /** Call once the run workflow reaches a terminal state or is purged. */
  release(runId: string): boolean {
    return this.reservations.delete(runId);
  }

  snapshot(): RunAdmissionSnapshotV1 {
    const reserved = this.reserved();
    return {
      maxActiveTaskAttempts: this.maxActiveTaskAttempts,
      reserved,
      available: this.maxActiveTaskAttempts - reserved,
      admittedRuns: this.reservations.size,
    };
  }
}
