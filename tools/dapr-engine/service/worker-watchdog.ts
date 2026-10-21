/**
 * Detects a Dapr workflow worker that has stopped pulling work items.
 *
 * Dapr JS SDK 3.18 only retries the work-item stream after a failed
 * connection attempt: the first stream error after a successful connect
 * (for example, the sidecar restarting) ends the worker permanently while
 * the process keeps serving its API. The service must not stay up with a
 * dead worker, so it treats that state as fatal and exits once its required
 * containers are reachable again; the container restart policy then starts a
 * fresh worker, and execution ownership fences any attempt that was in flight.
 */
export interface WorkflowWorkerProbe {
  /** True or false when the worker state is observable; undefined when it is not. */
  running(): boolean | undefined;
}

interface InnerWorker {
  readonly _isRunning?: unknown;
}

/** Reads the SDK's inner TaskHubGrpcWorker state; undefined if the SDK shape changes. */
export function sdkWorkflowWorkerProbe(runtime: object): WorkflowWorkerProbe {
  return {
    running() {
      const worker = (runtime as { readonly worker?: InnerWorker }).worker;
      return typeof worker?._isRunning === "boolean" ? worker._isRunning : undefined;
    },
  };
}

export interface WorkerWatchdogOptions {
  readonly probe: WorkflowWorkerProbe;
  /** Suppresses detection during an intentional shutdown. */
  readonly stopping: () => boolean;
  readonly onLost: () => void;
  readonly intervalMs?: number;
}

/** Polls the worker and calls onLost once when it stops outside an intentional shutdown. */
export function watchWorkflowWorker(options: WorkerWatchdogOptions): { stop(): void } {
  let reported = false;
  const timer = setInterval(() => {
    if (reported || options.stopping()) return;
    if (options.probe.running() === false) {
      reported = true;
      clearInterval(timer);
      options.onLost();
    }
  }, options.intervalMs ?? 1_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
