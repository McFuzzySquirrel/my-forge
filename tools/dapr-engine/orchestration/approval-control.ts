import {
  authorizeTaskApproval,
  canonicalDigest,
  type ApprovalBindingV1,
  type ApprovalContextV1,
  type ControlRejectionCode,
  type ControlRequestV1,
  type TrustedPrincipalV1,
} from "../contract/v1/index.ts";
import type {
  ControlStoreResult,
  StoredControlRecordV1,
} from "../storage/postgres/control-records.ts";
import {
  TASK_CONTROL_EVENT_NAME,
  type ResumeTaskActivityInputV1,
  type TaskActivityOutcomeV1,
} from "./workflow.ts";

export interface ApprovalControlStore {
  request(request: ControlRequestV1, principal?: TrustedPrincipalV1): Promise<ControlStoreResult>;
  get(controlId: string): Promise<StoredControlRecordV1 | undefined>;
  listAccepted(runId: string, limit: number): Promise<readonly StoredControlRecordV1[]>;
  transition(
    controlId: string,
    expectedRecordVersion: number,
    to: "accepted" | "applied" | "rejected",
    options?: {
      readonly reasonCode?: ControlRejectionCode;
      readonly approvalBinding?: ApprovalBindingV1;
    },
  ): Promise<ControlStoreResult>;
}

export interface WorkflowEventPublisher {
  raiseEvent(workflowInstanceId: string, eventName: string, eventPayload: unknown): Promise<void>;
}

export interface ApprovalWakeIdentityV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly logicalAttempt: number;
  readonly taskWorkflowInstanceId: string;
  readonly controlId: string;
}

export type ApprovalWakeResult =
  | { readonly ok: true; readonly binding: ApprovalBindingV1 }
  | { readonly ok: false; readonly code: ControlRejectionCode };

export class TaskApprovalCoordinator {
  constructor(
    private readonly store: ApprovalControlStore,
    private readonly events: WorkflowEventPublisher,
  ) {}

  async approve(
    request: ControlRequestV1,
    principal: TrustedPrincipalV1 | undefined,
    context: ApprovalContextV1 | undefined,
  ): Promise<ControlStoreResult> {
    if (request.action !== "approve-task") return { ok: false, code: "invalid-transition" };
    const requested = await this.store.request(request, principal);
    if (!requested.ok) return requested;
    let record = requested.record;
    if (record.state === "requested") {
      const authorized = authorizeTaskApproval(request, principal, context);
      if (!authorized.ok) {
        const rejected = await this.store.transition(record.controlId, record.recordVersion, "rejected", {
          reasonCode: authorized.code,
        });
        return rejected;
      }
      const accepted = await this.store.transition(record.controlId, record.recordVersion, "accepted", {
        approvalBinding: authorized.binding,
      });
      if (!accepted.ok) {
        record = (await this.store.get(record.controlId)) ?? record;
        if (record.state !== "accepted" || !sameBinding(record.approvalBinding, authorized.binding)) {
          return accepted;
        }
      } else {
        record = accepted.record;
      }
    }
    if (record.state === "accepted") await this.dispatchAccepted(record.controlId);
    return { ok: true, record, reused: requested.reused };
  }

  async dispatchAccepted(controlId: string): Promise<void> {
    const record = await this.store.get(controlId);
    if (!record) throw new Error(`Unknown approval control '${controlId}'`);
    if (record.action === "approve-task" && record.state === "applied") return;
    if (
      record.action !== "approve-task" ||
      record.state !== "accepted" ||
      !record.approvalBinding
    ) {
      throw new Error(`Control '${controlId}' is not an accepted task approval`);
    }
    await this.events.raiseEvent(
      record.approvalBinding.taskWorkflowInstanceId,
      TASK_CONTROL_EVENT_NAME,
      { controlId: record.controlId },
    );
  }
}

function sameBinding(
  left: ApprovalBindingV1 | undefined,
  right: ApprovalBindingV1,
): boolean {
  return left !== undefined && canonicalDigest(left) === canonicalDigest(right);
}

/** Validates that a wake event refers to a persisted approval for this exact attempt. */
export async function resolveApprovalWake(
  input: ApprovalWakeIdentityV1,
  store: Pick<ApprovalControlStore, "get">,
  currentContext: (input: ApprovalWakeIdentityV1) => Promise<ApprovalContextV1 | undefined>,
): Promise<ApprovalWakeResult> {
  const record = await store.get(input.controlId);
  if (!record) return { ok: false, code: "unknown-control" };
  if (
    record.action !== "approve-task" ||
    (record.state !== "accepted" && record.state !== "applied") ||
    !record.approvalBinding
  ) {
    return { ok: false, code: "invalid-task-state" };
  }

  const binding = record.approvalBinding;
  if (
    record.runId !== input.runId ||
    binding.runId !== input.runId ||
    binding.taskId !== input.taskId ||
    binding.manifestDigest !== input.manifestDigest ||
    binding.logicalAttempt !== input.logicalAttempt ||
    binding.taskWorkflowInstanceId !== input.taskWorkflowInstanceId ||
    binding.operatorId !== record.requestedBy ||
    record.payload.taskId !== input.taskId
  ) {
    return { ok: false, code: "stale-evidence" };
  }
  const context = await currentContext(input);
  if (!context) return { ok: false, code: "unknown-run" };
  if (
    context.runId !== input.runId ||
    context.taskId !== input.taskId ||
    context.manifestDigest !== input.manifestDigest ||
    context.logicalAttempt !== input.logicalAttempt ||
    context.taskWorkflowInstanceId !== input.taskWorkflowInstanceId
  ) {
    return { ok: false, code: "stale-evidence" };
  }
  if (context.taskStatus !== "waiting-for-approval") {
    return { ok: false, code: "invalid-task-state" };
  }
  if (
    !Array.isArray(record.payload.evidenceDigests) ||
    !record.payload.evidenceDigests.every((digest) =>
      typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) ||
    canonicalDigest([...record.payload.evidenceDigests].sort()) !==
      canonicalDigest([...binding.evidenceDigests].sort()) ||
    canonicalDigest([...context.evidenceDigests].sort()) !==
      canonicalDigest([...binding.evidenceDigests].sort())
  ) {
    return { ok: false, code: "stale-evidence" };
  }
  return { ok: true, binding };
}

export interface ResumeTaskActivityDependencies {
  readonly store: ApprovalControlStore;
  readonly currentContext: (
    input: ApprovalWakeIdentityV1,
  ) => Promise<ApprovalContextV1 | undefined>;
  readonly resume: (
    input: ResumeTaskActivityInputV1,
    binding: ApprovalBindingV1,
  ) => Promise<TaskActivityOutcomeV1>;
}

/** Validates a durable approval before resuming its task; retries reuse operationId. */
export function createResumeTaskActivity(
  dependencies: ResumeTaskActivityDependencies,
): (_context: unknown, input: ResumeTaskActivityInputV1) => Promise<TaskActivityOutcomeV1> {
  return async (_context, input) => {
    const wake = await resolveApprovalWake(input, dependencies.store, dependencies.currentContext);
    if (!wake.ok) {
      const record = await dependencies.store.get(input.controlId);
      if (record?.state === "accepted") {
        const rejected = await dependencies.store.transition(
          record.controlId,
          record.recordVersion,
          "rejected",
          { reasonCode: wake.code },
        );
        if (!rejected.ok) {
          throw new Error(`Could not reject invalid approval '${input.controlId}': ${rejected.code}`);
        }
      }
      return {
        status: "failed",
        retryable: false,
        failureCode: "approval-rejected",
        reason: wake.code,
      };
    }

    const outcome = await dependencies.resume(input, wake.binding);
    const record = await dependencies.store.get(input.controlId);
    if (!record) throw new Error(`Unknown approval control '${input.controlId}'`);
    if (record.state === "accepted") {
      const applied = await dependencies.store.transition(
        record.controlId,
        record.recordVersion,
        "applied",
        { approvalBinding: wake.binding },
      );
      if (!applied.ok) {
        const latest = await dependencies.store.get(input.controlId);
        if (
          applied.code !== "stale-revision" ||
          latest?.state !== "applied" ||
          !sameBinding(latest.approvalBinding, wake.binding)
        ) {
          throw new Error(`Could not apply approval '${input.controlId}': ${applied.code}`);
        }
      }
    } else if (record.state !== "applied" || !sameBinding(record.approvalBinding, wake.binding)) {
      throw new Error(`Approval '${input.controlId}' is no longer applicable`);
    }
    return outcome;
  };
}
