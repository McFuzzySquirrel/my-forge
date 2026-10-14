import type {
  ControlAction,
  ControlRejectionCode,
  ControlRequestV1,
  RunStatusV1,
  TaskStatusV1,
  TrustedPrincipalV1,
} from "../contract/v1/index.ts";
import type {
  ControlStoreResult,
  StoredControlRecordV1,
} from "../storage/postgres/control-records.ts";
import type { ApprovalControlStore, WorkflowEventPublisher } from "./approval-control.ts";
import {
  RUN_CONTROL_EVENT_NAME,
  type AppliedRunControlV1,
  runOrchestrationWorkflowId,
} from "./workflow.ts";

function isRunControlAction(
  action: ControlAction,
): action is "pause" | "resume" | "stop" | "cancel" | "replay-task" {
  return action === "pause" || action === "resume" || action === "stop"
    || action === "cancel" || action === "replay-task";
}

export interface RunControlContextV1 {
  readonly runId: string;
  readonly status: RunStatusV1;
  readonly taskStatuses: Readonly<Record<string, TaskStatusV1>>;
}

export interface RunControlContextReader {
  getRunControlContext(runId: string): Promise<RunControlContextV1 | undefined>;
}

function rejectionFor(
  request: ControlRequestV1,
  context: RunControlContextV1 | undefined,
): ControlRejectionCode | undefined {
  if (!context || context.runId !== request.runId) return "unknown-run";
  switch (request.action) {
    case "select-tasks":
      return "selection-immutable";
    case "pause":
    case "stop":
      return context.status === "running" ? undefined : "invalid-run-state";
    case "resume":
      return context.status === "paused" ? undefined : "invalid-run-state";
    case "cancel":
      return ["queued", "running", "pausing", "paused", "stopping"].includes(context.status)
        ? undefined
        : "invalid-run-state";
    case "replay-task": {
      if (context.status === "cancelled" || context.status === "cancelling") return "invalid-run-state";
      const taskId = request.payload.taskId;
      if (typeof taskId !== "string" || !(taskId in context.taskStatuses)) return "unknown-task";
      return context.taskStatuses[taskId] === "complete" || context.taskStatuses[taskId] === "failed"
        ? undefined
        : "invalid-task-state";
    }
    case "approve-task":
      return undefined;
  }
}

export class RunControlCoordinator {
  constructor(
    private readonly store: ApprovalControlStore,
    private readonly contexts: RunControlContextReader,
    private readonly events: WorkflowEventPublisher,
  ) {}

  async request(
    request: ControlRequestV1,
    principal?: TrustedPrincipalV1,
  ): Promise<ControlStoreResult> {
    if (request.action === "approve-task") return { ok: false, code: "invalid-transition" };
    const requested = await this.store.request(request, principal);
    if (!requested.ok) return requested;
    let record = requested.record;

    if (record.state === "requested") {
      const context = await this.contexts.getRunControlContext(request.runId);
      const reasonCode = rejectionFor(request, context);
      const next = reasonCode
        ? await this.store.transition(record.controlId, record.recordVersion, "rejected", { reasonCode })
        : await this.store.transition(record.controlId, record.recordVersion, "accepted");
      if (!next.ok) {
        const latest = await this.store.get(record.controlId);
        if (latest?.state !== "accepted" && latest?.state !== "rejected" && latest?.state !== "applied") {
          return next;
        }
        record = latest;
      } else {
        record = next.record;
      }
    }

    if (record.state === "accepted") await this.dispatchAccepted(record.controlId);
    return { ok: true, record, reused: requested.reused };
  }

  async dispatchAccepted(controlId: string): Promise<void> {
    const record = await this.store.get(controlId);
    if (!record) throw new Error(`Unknown run control '${controlId}'`);
    if (record.action === "approve-task" || record.state === "applied") return;
    if (record.state !== "accepted") {
      throw new Error(`Run control '${controlId}' is not accepted`);
    }
    await this.events.raiseEvent(
      runOrchestrationWorkflowId(record.runId),
      RUN_CONTROL_EVENT_NAME,
      { controlId: record.controlId },
    );
  }
}

export interface RunControlEffects {
  /** Pause and stop take effect after dispatched tasks reach a task boundary. */
  pauseOrStop(record: StoredControlRecordV1): Promise<void>;
  resume(record: StoredControlRecordV1): Promise<void>;
  /** Resolve only after owned-process cleanup is observed and late results are fenced. */
  cancel(record: StoredControlRecordV1): Promise<void>;
  /** Allocate a fresh logical attempt without mutating prior attempt records. */
  replayTask(record: StoredControlRecordV1): Promise<number>;
}

export function createGetRunControlActivity(
  store: Pick<ApprovalControlStore, "get">,
): (_context: unknown, input: { readonly controlId: string }) => Promise<StoredControlRecordV1> {
  return async (_context, input) => {
    const record = await store.get(input.controlId);
    if (!record) throw new Error(`Unknown run control '${input.controlId}'`);
    if (record.action === "approve-task") throw new Error("Task approvals use task-control events");
    if (record.state !== "accepted" && record.state !== "applied") {
      throw new Error(`Run control '${input.controlId}' is not accepted`);
    }
    return record;
  };
}

/** Applies an accepted control idempotently; effects must deduplicate by controlId. */
export function createApplyRunControlActivity(
  store: Pick<ApprovalControlStore, "get" | "transition">,
  effects: RunControlEffects,
): (_context: unknown, input: { readonly controlId: string }) => Promise<AppliedRunControlV1> {
  return async (_context, input) => {
    let record = await store.get(input.controlId);
    if (!record) throw new Error(`Unknown run control '${input.controlId}'`);
    if (!isRunControlAction(record.action)) {
      throw new Error("This control action cannot be applied by the run workflow");
    }
    const action = record.action;
    if (record.state === "applied") {
      const replayLogicalAttempt = action === "replay-task"
        ? await effects.replayTask(record)
        : undefined;
      return {
        controlId: record.controlId,
        runId: record.runId,
        action,
        state: "applied",
        payload: record.payload,
        ...(replayLogicalAttempt === undefined ? {} : { replayLogicalAttempt }),
      };
    }
    if (record.state !== "accepted") {
      throw new Error(`Run control '${input.controlId}' is not accepted`);
    }

    let replayLogicalAttempt: number | undefined;
    switch (action) {
      case "pause":
      case "stop":
        await effects.pauseOrStop(record);
        break;
      case "resume":
        await effects.resume(record);
        break;
      case "cancel":
        await effects.cancel(record);
        break;
      case "replay-task":
        replayLogicalAttempt = await effects.replayTask(record);
        if (!Number.isSafeInteger(replayLogicalAttempt) || replayLogicalAttempt < 1) {
          throw new Error(`Replay effect returned an invalid logical attempt for '${record.controlId}'`);
        }
        break;
    }

    const applied = await store.transition(record.controlId, record.recordVersion, "applied");
    if (applied.ok) {
      return {
        controlId: applied.record.controlId,
        runId: applied.record.runId,
        action,
        state: "applied",
        payload: applied.record.payload,
        ...(replayLogicalAttempt === undefined ? {} : { replayLogicalAttempt }),
      };
    }
    record = (await store.get(record.controlId)) ?? record;
    if (applied.code === "stale-revision" && record.state === "applied") {
      replayLogicalAttempt = action === "replay-task"
        ? await effects.replayTask(record)
        : undefined;
      return {
        controlId: record.controlId,
        runId: record.runId,
        action,
        state: "applied",
        payload: record.payload,
        ...(replayLogicalAttempt === undefined ? {} : { replayLogicalAttempt }),
      };
    }
    throw new Error(`Could not apply run control '${input.controlId}': ${applied.code}`);
  };
}
