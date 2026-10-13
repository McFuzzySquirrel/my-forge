import type {
  ExecutionClaimV1,
  ExecutionOwnershipRejection,
  ExecutionStartRejection,
  ExecutionStopReason,
  HeartbeatDirective,
  OperationExecutionV1,
  OperationKeyV1,
  ProcessCleanup,
  ProcessExitV1,
} from "../contract/v1/index.ts";

/**
 * Durable execution-ownership operations the supervisor needs. The PostgreSQL
 * adapter in `storage/postgres/operation-executions.ts` implements this with
 * the contract v1 decision functions; Dapr activities adapt to it.
 */
export interface ExecutionOwnershipStore {
  start(input: {
    readonly key: OperationKeyV1;
    readonly workerId: string;
    readonly budgetMs: number;
    readonly heartbeatTtlMs: number;
  }): Promise<
    | { readonly ok: true; readonly execution: OperationExecutionV1 }
    | { readonly ok: false; readonly code: ExecutionStartRejection; readonly execution?: OperationExecutionV1 }
  >;
  heartbeat(key: OperationKeyV1, claim: ExecutionClaimV1, heartbeatTtlMs: number): Promise<
    | { readonly ok: true; readonly directive: HeartbeatDirective; readonly execution: OperationExecutionV1 }
    | { readonly ok: false; readonly code: ExecutionOwnershipRejection }
  >;
  recordExit(key: OperationKeyV1, claim: ExecutionClaimV1, exit: Omit<ProcessExitV1, "observedAt">): Promise<
    | { readonly ok: true; readonly execution: OperationExecutionV1 }
    | { readonly ok: false; readonly code: ExecutionOwnershipRejection }
  >;
}

export interface SupervisedRunContext {
  /** Aborted on deadline, cancellation, or loss of ownership; pass it to the harness request. */
  readonly signal: AbortSignal;
  /** Remaining attempt budget; use it as the harness request's `timeoutMs`. */
  readonly remainingMs: number;
  readonly claim: ExecutionClaimV1;
  /** Pass as `isolation.onProcessSettled` so cleanup evidence reaches the exit record. */
  readonly onProcessSettled: (cleanup: ProcessCleanup) => void;
}

export interface SupervisedExecutionOptions<T> {
  readonly store: ExecutionOwnershipStore;
  readonly key: OperationKeyV1;
  readonly workerId: string;
  /** Attempt budget, fixed by the first epoch and preserved across takeover. */
  readonly budgetMs: number;
  readonly heartbeatIntervalMs: number;
  /** Must exceed the interval so one delayed renewal does not lose ownership. */
  readonly heartbeatTtlMs: number;
  /** External cancellation, e.g. a worker shutting down. */
  readonly signal?: AbortSignal;
  run(context: SupervisedRunContext): Promise<T>;
  /** Extracts the harness exit status from the run result for the exit record. */
  exitStatus?(result: T): number | null;
}

export type SupervisedExecutionResult<T> =
  | {
      readonly started: false;
      readonly code: ExecutionStartRejection;
      readonly execution?: OperationExecutionV1;
    }
  | {
      readonly started: true;
      readonly claim: ExecutionClaimV1;
      readonly result?: T;
      readonly error?: unknown;
      readonly stopReason?: ExecutionStopReason;
      readonly cleanup: ProcessCleanup;
      /** The recorded exit; absent when ownership was lost or the record was rejected. */
      readonly execution?: OperationExecutionV1;
      readonly exitRejection?: ExecutionOwnershipRejection | "store-unavailable";
    };

/**
 * Runs one harness execution under a durable ownership epoch. Timeout and
 * cancellation become an `AbortSignal` that `runCommand` turns into
 * process-group termination; the supervisor waits for the harness to settle
 * (exit observed) before recording the exit. The caller must then submit the
 * outcome through the store's admission check, which rejects late or stale
 * outcomes; a successful exit record is not acceptance.
 */
export async function superviseExecution<T>(options: SupervisedExecutionOptions<T>): Promise<SupervisedExecutionResult<T>> {
  if (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1) {
    throw new RangeError("Heartbeat interval must be a positive safe integer of milliseconds");
  }
  if (!Number.isSafeInteger(options.heartbeatTtlMs) || options.heartbeatTtlMs <= options.heartbeatIntervalMs) {
    throw new RangeError("Heartbeat TTL must exceed the heartbeat interval");
  }
  const started = await options.store.start({
    key: options.key,
    workerId: options.workerId,
    budgetMs: options.budgetMs,
    heartbeatTtlMs: options.heartbeatTtlMs,
  });
  if (!started.ok) return { started: false, code: started.code, ...(started.execution ? { execution: started.execution } : {}) };

  const claim: ExecutionClaimV1 = { executionEpoch: started.execution.executionEpoch, workerId: options.workerId };
  const controller = new AbortController();
  let stopReason: ExecutionStopReason | undefined;
  const stop = (reason: ExecutionStopReason) => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort(new Error(`Execution stopped: ${reason}`));
  };

  const remainingMs = Date.parse(started.execution.deadlineAt) - Date.now();
  const deadlineTimer = setTimeout(() => stop("deadline"), Math.max(0, remainingMs));
  const onExternalAbort = () => stop("cancel");
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) stop("cancel");
  if (remainingMs <= 0) stop("deadline");

  let lastRenewalMs = Date.now();
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let supervising = true;
  const scheduleHeartbeat = () => {
    if (!supervising) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatInFlight = (async () => {
        try {
          const renewed = await options.store.heartbeat(options.key, claim, options.heartbeatTtlMs);
          if (!renewed.ok) stop("ownership-lost");
          else {
            lastRenewalMs = Date.now();
            if (renewed.directive === "cancel") stop("cancel");
            else if (renewed.directive === "deadline") stop("deadline");
          }
        } catch {
          // A store outage is tolerated only until the last renewal would expire.
          if (Date.now() - lastRenewalMs >= options.heartbeatTtlMs) stop("ownership-lost");
        } finally {
          heartbeatInFlight = undefined;
          scheduleHeartbeat();
        }
      })();
    }, options.heartbeatIntervalMs);
  };
  scheduleHeartbeat();

  let cleanup: ProcessCleanup | undefined;
  const context: SupervisedRunContext = {
    signal: controller.signal,
    remainingMs: Math.max(1, remainingMs),
    claim,
    onProcessSettled: (settled) => {
      if (cleanup !== "unconfirmed") cleanup = settled;
    },
  };

  let result: T | undefined;
  let error: unknown;
  let failed = false;
  try {
    result = await options.run(context);
  } catch (caught) {
    failed = true;
    error = caught;
  } finally {
    supervising = false;
    clearTimeout(deadlineTimer);
    clearTimeout(heartbeatTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    await heartbeatInFlight;
  }

  // `runCommand` resolves only after the process (tree) closed or its kill
  // was confirmed; an unconfirmed kill was reported through onProcessSettled.
  const observedCleanup: ProcessCleanup = cleanup ?? "observed";
  const base = {
    started: true as const,
    claim,
    ...(failed ? { error } : { result }),
    ...(stopReason ? { stopReason } : {}),
    cleanup: observedCleanup,
  };
  if (stopReason === "ownership-lost") return { ...base, exitRejection: "stale-execution" };

  const status = !failed && result !== undefined && options.exitStatus ? options.exitStatus(result) : null;
  try {
    const recorded = await options.store.recordExit(options.key, claim, {
      status,
      ...(stopReason ? { stopReason } : {}),
      cleanup: observedCleanup,
    });
    return recorded.ok ? { ...base, execution: recorded.execution } : { ...base, exitRejection: recorded.code };
  } catch {
    return { ...base, exitRejection: "store-unavailable" };
  }
}
