import {
  SCHEMA_VERSION,
  canonicalDigest,
  type ApprovalBindingV1,
  type ControlAction,
  type ControlRecordV1,
  type ControlRejectionCode,
  type ControlRequestV1,
  type ControlState,
  type JsonValue,
  type Sha256Digest,
  type TrustedPrincipalV1,
} from "../../contract/v1/index.ts";
import type { SqlQueryable } from "./operation-receipts.ts";

export interface StoredControlRecordV1 extends ControlRecordV1 {
  readonly recordVersion: number;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly requestedBy?: string;
  readonly approvalBinding?: ApprovalBindingV1;
}

export type ControlStoreResult =
  | { readonly ok: true; readonly record: StoredControlRecordV1; readonly reused: boolean }
  | {
    readonly ok: false;
    readonly code: "control-conflict" | "unknown-control" | "stale-revision" |
      "invalid-transition" | "invalid-approval-binding";
  };

interface ControlRow extends Record<string, unknown> {
  schema_version: number;
  control_id: string;
  run_id: string;
  action: ControlAction;
  request_digest: string;
  payload: Record<string, unknown> | string;
  requested_by: string | null;
  state: ControlState;
  history: ControlState[] | string;
  reason_code: ControlRejectionCode | null;
  approval_binding: ApprovalBindingV1 | string | null;
  record_version: string | number;
}

const CONTROL_COLUMNS = `
  schema_version, control_id, run_id, action, request_digest, payload,
  requested_by, state, history, reason_code, approval_binding, record_version
`;

const ACTIONS: readonly ControlAction[] = [
  "select-tasks", "pause", "resume", "stop", "cancel", "replay-task", "approve-task",
];
const MAX_CONTROL_PAYLOAD_BYTES = 64 * 1024;

const REJECTION_CODES: readonly ControlRejectionCode[] = [
  "unsupported-schema-version", "unknown-run", "unknown-control", "control-conflict", "invalid-run-state",
  "invalid-task-state", "unknown-task", "selection-immutable",
  "operator-identity-required", "stale-evidence",
];

function parseJson<T>(value: T | string, field: string): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Database returned invalid ${field} JSON`);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateRequest(request: ControlRequestV1, principal?: TrustedPrincipalV1): void {
  if (!request) throw new TypeError("Control request is required");
  if (request.schemaVersion !== SCHEMA_VERSION) throw new TypeError("Unsupported control schema version");
  if (!isUuid(request.controlId) || !request.runId || !ACTIONS.includes(request.action)) {
    throw new TypeError("Control request requires a UUID, run identity, and supported action");
  }
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new TypeError("Control payload must be an object");
  }
  if (principal && (typeof principal.subject !== "string" || !principal.subject.trim())) {
    throw new TypeError("Trusted principal subject must not be empty");
  }
  if (Buffer.byteLength(JSON.stringify(request.payload), "utf8") > MAX_CONTROL_PAYLOAD_BYTES) {
    throw new RangeError(`Control payload exceeds ${MAX_CONTROL_PAYLOAD_BYTES} bytes`);
  }
}

function requestDigest(request: ControlRequestV1): Sha256Digest {
  return canonicalDigest({ runId: request.runId, action: request.action, payload: request.payload });
}

function toRecord(row: ControlRow): StoredControlRecordV1 {
  if (row.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported control record schema version: ${row.schema_version}`);
  }
  const version = Number(row.record_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid control record version: ${row.record_version}`);
  }
  const history = parseJson(row.history, "control history");
  if (!Array.isArray(history) || !history.every((entry) =>
    entry === "requested" || entry === "accepted" || entry === "applied" || entry === "rejected")) {
    throw new Error("Database returned invalid control record history");
  }
  if (!ACTIONS.includes(row.action)) throw new Error(`Database returned unsupported control action: ${row.action}`);
  if (row.reason_code !== null && !REJECTION_CODES.includes(row.reason_code)) {
    throw new Error(`Database returned unsupported control rejection code: ${row.reason_code}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(row.request_digest)) {
    throw new Error("Database returned an invalid control request digest");
  }

  const approvalBinding = row.approval_binding === null
    ? undefined
    : parseApprovalBinding(parseJson(row.approval_binding, "approval binding"));
  const payload = parseJson(row.payload, "control payload");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Database returned invalid control payload");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    controlId: row.control_id,
    runId: row.run_id,
    action: row.action,
    requestDigest: row.request_digest as Sha256Digest,
    state: row.state,
    history,
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    recordVersion: version,
    payload: payload as Record<string, JsonValue>,
    ...(row.requested_by === null ? {} : { requestedBy: row.requested_by }),
    ...(approvalBinding === undefined ? {} : { approvalBinding }),
  };
}

function isApprovalBinding(value: unknown): value is ApprovalBindingV1 {
  if (
    !value || typeof value !== "object" ||
    !("runId" in value) || typeof value.runId !== "string" || !value.runId ||
    !("manifestDigest" in value) || typeof value.manifestDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.manifestDigest) ||
    !("taskId" in value) || typeof value.taskId !== "string" || !value.taskId ||
    !("logicalAttempt" in value) || typeof value.logicalAttempt !== "number" ||
    !Number.isSafeInteger(value.logicalAttempt) || value.logicalAttempt < 1 ||
    !("taskWorkflowInstanceId" in value) || typeof value.taskWorkflowInstanceId !== "string" ||
    !value.taskWorkflowInstanceId.trim() ||
    !("evidenceDigests" in value) ||
    !Array.isArray(value.evidenceDigests) ||
    !value.evidenceDigests.every((digest) => typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) ||
    !("operatorId" in value) || typeof value.operatorId !== "string" || !value.operatorId
  ) {
    return false;
  }
  return true;
}

function parseApprovalBinding(value: unknown): ApprovalBindingV1 {
  if (!isApprovalBinding(value)) throw new Error("Database returned an invalid approval binding");
  return value;
}

function validTransition(from: ControlState, to: ControlState): boolean {
  return (from === "requested" && (to === "accepted" || to === "rejected"))
    || (from === "accepted" && (to === "applied" || to === "rejected"));
}

export class PostgresControlRecordStore {
  constructor(private readonly database: SqlQueryable) {}

  async request(
    request: ControlRequestV1,
    principal?: TrustedPrincipalV1,
  ): Promise<ControlStoreResult> {
    validateRequest(request, principal);
    const digest = requestDigest(request);
    const inserted = await this.database.query<ControlRow>(
      `INSERT INTO forge_control_records
        (schema_version, control_id, run_id, action, request_digest, payload, requested_by,
         state, history, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'requested', '["requested"]'::jsonb, 1, NOW(), NOW())
       ON CONFLICT (control_id) DO NOTHING
       RETURNING ${CONTROL_COLUMNS}`,
      [
        SCHEMA_VERSION, request.controlId, request.runId, request.action, digest,
        JSON.stringify(request.payload), principal?.subject ?? null,
      ],
    );
    if (inserted.rows[0]) {
      return { ok: true, record: toRecord(inserted.rows[0]), reused: false };
    }

    const existing = await this.get(request.controlId);
    if (!existing) throw new Error("Control request conflicted but the existing record could not be read");
    return existing.requestDigest === digest
      ? { ok: true, record: existing, reused: true }
      : { ok: false, code: "control-conflict" };
  }

  async get(controlId: string): Promise<StoredControlRecordV1 | undefined> {
    if (!isUuid(controlId)) throw new TypeError("Control ID must be a UUID");
    const result = await this.database.query<ControlRow>(
      `SELECT ${CONTROL_COLUMNS}
       FROM forge_control_records
       WHERE control_id = $1`,
      [controlId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async getApproval(
    runId: string,
    taskId: string,
    logicalAttempt: number,
  ): Promise<ApprovalBindingV1 | undefined> {
    if (!runId || !taskId || !Number.isSafeInteger(logicalAttempt) || logicalAttempt < 1) {
      throw new TypeError("Approval lookup requires run/task identities and a positive logical attempt");
    }
    const result = await this.database.query<ControlRow>(
      `SELECT ${CONTROL_COLUMNS}
       FROM forge_control_records
       WHERE run_id = $1 AND action = 'approve-task' AND state = 'applied'
         AND approval_binding->>'taskId' = $2
         AND approval_binding->>'logicalAttempt' ~ '^[1-9][0-9]*$'
         AND (approval_binding->>'logicalAttempt')::numeric = $3
       ORDER BY updated_at DESC, control_id DESC
       LIMIT 1`,
      [runId, taskId, logicalAttempt],
    );
    if (!result.rows[0]) return undefined;
    const record = toRecord(result.rows[0]);
    return record.approvalBinding;
  }

  async transition(
    controlId: string,
    expectedRecordVersion: number,
    to: Exclude<ControlState, "requested">,
    options: {
      readonly reasonCode?: ControlRejectionCode;
      readonly approvalBinding?: ApprovalBindingV1;
    } = {},
  ): Promise<ControlStoreResult> {
    if (!Number.isSafeInteger(expectedRecordVersion) || expectedRecordVersion < 1) {
      throw new TypeError("Expected control record version must be a positive safe integer");
    }
    if (!isUuid(controlId)) throw new TypeError("Control ID must be a UUID");
    const current = await this.get(controlId);
    if (!current) return { ok: false, code: "unknown-control" };
    if (current.recordVersion !== expectedRecordVersion) return { ok: false, code: "stale-revision" };
    if (!validTransition(current.state, to)) return { ok: false, code: "invalid-transition" };
    if (
      (to === "rejected") !== (options.reasonCode !== undefined) ||
      (to === "rejected" && !REJECTION_CODES.includes(options.reasonCode!))
    ) {
      return { ok: false, code: "invalid-transition" };
    }
    if (
      (options.approvalBinding !== undefined && !isApprovalBinding(options.approvalBinding)) ||
      (options.approvalBinding !== undefined &&
        (current.action !== "approve-task" || (to !== "accepted" && to !== "applied") ||
          options.approvalBinding.runId !== current.runId ||
          options.approvalBinding.operatorId !== current.requestedBy)) ||
      (current.action === "approve-task" &&
        (to === "accepted" || to === "applied") &&
        !options.approvalBinding)
    ) {
      return { ok: false, code: "invalid-approval-binding" };
    }
    if (options.approvalBinding) {
      const payload = current.payload as Readonly<Record<string, unknown>>;
      if (
        payload.taskId !== options.approvalBinding.taskId ||
        !Array.isArray(payload.evidenceDigests) ||
        !payload.evidenceDigests.every((digest) => typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) ||
        canonicalDigest([...payload.evidenceDigests].sort()) !==
          canonicalDigest([...options.approvalBinding.evidenceDigests].sort())
      ) {
        return { ok: false, code: "invalid-approval-binding" };
      }
    }

    const updated = await this.database.query<ControlRow>(
      `UPDATE forge_control_records
       SET state = $1,
           history = history || jsonb_build_array($1::text),
           reason_code = $2,
           approval_binding = $3::jsonb,
           record_version = record_version + 1,
           updated_at = NOW()
       WHERE control_id = $4 AND record_version = $5 AND state = $6
       RETURNING ${CONTROL_COLUMNS}`,
      [
        to, options.reasonCode ?? null,
        options.approvalBinding ? JSON.stringify(options.approvalBinding) : null,
        controlId, expectedRecordVersion, current.state,
      ],
    );
    if (updated.rows[0]) {
      return { ok: true, record: toRecord(updated.rows[0]), reused: false };
    }
    return { ok: false, code: "stale-revision" };
  }
}
