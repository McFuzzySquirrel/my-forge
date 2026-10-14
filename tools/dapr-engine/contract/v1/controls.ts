import { canonicalDigest } from "./canonical-json.ts";
import {
  SCHEMA_VERSION,
  type ControlRequestV1,
  type Sha256Digest,
  type TaskStatusV1,
} from "./types.ts";

export interface TrustedPrincipalV1 {
  /** Stable subject from an authenticated identity provider, not request data. */
  readonly subject: string;
  readonly roles: readonly string[];
}

export interface ApprovalContextV1 {
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly taskWorkflowInstanceId: string;
  readonly taskStatus: TaskStatusV1;
  readonly evidenceDigests: readonly Sha256Digest[];
}

export interface ApprovalBindingV1 {
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly taskWorkflowInstanceId: string;
  readonly evidenceDigests: readonly Sha256Digest[];
  readonly operatorId: string;
}

export type ApprovalAuthorizationResult =
  | { readonly ok: true; readonly binding: ApprovalBindingV1 }
  | {
    readonly ok: false;
    readonly code: "unsupported-schema-version" | "unknown-run" | "unknown-task" |
      "invalid-task-state" | "operator-identity-required" | "stale-evidence";
  };

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Builds an immutable approval only from a trusted principal and current
 * service-owned task state. The caller must authenticate the principal before
 * invoking this function; request payloads are never identity claims.
 */
export function authorizeTaskApproval(
  request: ControlRequestV1,
  principal: TrustedPrincipalV1 | undefined,
  context: ApprovalContextV1 | undefined,
): ApprovalAuthorizationResult {
  if (!request || request.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: "unsupported-schema-version" };
  }
  if (request.action !== "approve-task") {
    return { ok: false, code: "invalid-task-state" };
  }
  if (
    !principal ||
    typeof principal.subject !== "string" ||
    !principal.subject.trim() ||
    !Array.isArray(principal.roles) ||
    !principal.roles.includes("operator")
  ) {
    return { ok: false, code: "operator-identity-required" };
  }

  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "stale-evidence" };
  }
  const taskId = payload.taskId;
  const evidenceDigests = payload.evidenceDigests;
  if (typeof taskId !== "string" || !taskId) return { ok: false, code: "unknown-task" };
  if (!context || !context.runId) return { ok: false, code: "unknown-run" };
  if (request.runId !== context.runId || taskId !== context.taskId) {
    return { ok: false, code: "unknown-task" };
  }
  if (context.taskStatus !== "waiting-for-approval") {
    return { ok: false, code: "invalid-task-state" };
  }
  if (
    !Number.isSafeInteger(context.logicalAttempt) || context.logicalAttempt < 1 ||
    typeof context.taskWorkflowInstanceId !== "string" || !context.taskWorkflowInstanceId.trim() ||
    !isDigest(context.manifestDigest) ||
    !Array.isArray(context.evidenceDigests) ||
    !context.evidenceDigests.every(isDigest) ||
    !stringArray(evidenceDigests) ||
    !evidenceDigests.every(isDigest) ||
    canonicalDigest([...evidenceDigests].sort()) !== canonicalDigest([...context.evidenceDigests].sort())
  ) {
    return { ok: false, code: "stale-evidence" };
  }

  return {
    ok: true,
    binding: {
      runId: context.runId,
      manifestDigest: context.manifestDigest,
      taskId: context.taskId,
      logicalAttempt: context.logicalAttempt,
      taskWorkflowInstanceId: context.taskWorkflowInstanceId,
      evidenceDigests: [...context.evidenceDigests],
      operatorId: principal.subject,
    },
  };
}
