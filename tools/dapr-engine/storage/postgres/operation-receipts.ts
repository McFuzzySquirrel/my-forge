import {
  canTransitionReceipt,
  SCHEMA_VERSION,
  type OperationKeyV1,
  type OperationReceiptV1,
  type ReceiptState,
  type Sha256Digest,
} from "../../contract/v1/index.ts";

export const MAX_DIAGNOSTIC_REFERENCES = 32;
export const MAX_DIAGNOSTIC_REFERENCE_LENGTH = 2048;

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface SqlQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export type ReceiptStoreResult =
  | { readonly ok: true; readonly receipt: OperationReceiptV1; readonly reused: boolean }
  | {
      readonly ok: false;
      readonly code:
        | "stale-revision"
        | "invalid-transition"
        | "conflicting-effect"
        | "unknown-receipt"
        | "missing-effect-digest"
        | "invalid-diagnostic-ref"
        | "too-many-diagnostic-refs";
    };

interface ReceiptRow extends Record<string, unknown> {
  schema_version: number;
  run_id: string;
  task_id: string;
  logical_attempt: number;
  operation_id: string;
  state: ReceiptState;
  record_version: string | number;
  effect_digest: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  diagnostic_refs: string[] | string;
}

const RECEIPT_COLUMNS = `
  schema_version, run_id, task_id, logical_attempt, operation_id, state,
  record_version, effect_digest, created_at, updated_at, diagnostic_refs
`;

function validateKey(key: OperationKeyV1): void {
  if (
    !key.runId || !key.taskId || !key.operationId ||
    !Number.isSafeInteger(key.logicalAttempt) || key.logicalAttempt < 1
  ) {
    throw new TypeError("Operation receipt key must contain non-empty identities and a positive safe logical attempt");
  }
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Database returned an invalid receipt timestamp");
  return date.toISOString();
}

function toReceipt(row: ReceiptRow): OperationReceiptV1 {
  if (row.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported operation receipt schema version: ${row.schema_version}`);
  }
  const version = Number(row.record_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid operation receipt record version: ${row.record_version}`);
  }
  const diagnosticRefs = typeof row.diagnostic_refs === "string"
    ? JSON.parse(row.diagnostic_refs) as unknown
    : row.diagnostic_refs;
  if (!Array.isArray(diagnosticRefs) || !diagnosticRefs.every((ref) => typeof ref === "string")) {
    throw new Error("Database returned invalid operation receipt diagnostic references");
  }
  if (
    row.effect_digest !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(row.effect_digest)
  ) {
    throw new Error("Database returned an invalid operation receipt effect digest");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    key: {
      runId: row.run_id,
      taskId: row.task_id,
      logicalAttempt: row.logical_attempt,
      operationId: row.operation_id,
    },
    state: row.state,
    recordVersion: version,
    ...(row.effect_digest === null ? {} : { effectDigest: row.effect_digest as Sha256Digest }),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    diagnosticRefs,
  };
}

function keyValues(key: OperationKeyV1): unknown[] {
  return [key.runId, key.taskId, key.logicalAttempt, key.operationId];
}

export class PostgresOperationReceiptStore {
  constructor(private readonly database: SqlQueryable) {}

  async claim(key: OperationKeyV1): Promise<ReceiptStoreResult> {
    validateKey(key);
    const inserted = await this.database.query<ReceiptRow>(
      `INSERT INTO forge_operation_receipts
        (schema_version, run_id, task_id, logical_attempt, operation_id, state, record_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'claimed', 1, NOW(), NOW())
       ON CONFLICT (run_id, task_id, logical_attempt, operation_id) DO NOTHING
       RETURNING ${RECEIPT_COLUMNS}`,
      [SCHEMA_VERSION, ...keyValues(key)],
    );
    if (inserted.rows[0]) {
      return { ok: true, receipt: toReceipt(inserted.rows[0]), reused: false };
    }

    const existing = await this.get(key);
    if (!existing) {
      throw new Error("Receipt claim conflicted but the existing receipt could not be read");
    }
    return { ok: true, receipt: existing, reused: true };
  }

  async get(key: OperationKeyV1): Promise<OperationReceiptV1 | undefined> {
    validateKey(key);
    const result = await this.database.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
       FROM forge_operation_receipts
       WHERE run_id = $1 AND task_id = $2 AND logical_attempt = $3 AND operation_id = $4`,
      keyValues(key),
    );
    return result.rows[0] ? toReceipt(result.rows[0]) : undefined;
  }

  async listReconciliationCandidates(limit = 100): Promise<OperationReceiptV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Reconciliation candidate limit must be between 1 and 1000");
    }
    const result = await this.database.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
       FROM forge_operation_receipts
       WHERE state IN ('claimed', 'executing', 'effect-published', 'ambiguous')
       ORDER BY updated_at, run_id, task_id, logical_attempt, operation_id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(toReceipt);
  }

  async transition(
    key: OperationKeyV1,
    expectedVersion: number,
    to: ReceiptState,
    options: { readonly effectDigest?: Sha256Digest; readonly diagnosticRef?: string } = {},
  ): Promise<ReceiptStoreResult> {
    validateKey(key);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("Expected receipt version must be a positive safe integer");
    }
    if (
      options.diagnosticRef !== undefined &&
      (!options.diagnosticRef || options.diagnosticRef.length > MAX_DIAGNOSTIC_REFERENCE_LENGTH)
    ) {
      return { ok: false, code: "invalid-diagnostic-ref" };
    }

    const current = await this.get(key);
    if (!current) return { ok: false, code: "unknown-receipt" };
    if (current.recordVersion !== expectedVersion) return { ok: false, code: "stale-revision" };
    if (options.effectDigest && current.effectDigest && options.effectDigest !== current.effectDigest) {
      return { ok: false, code: "conflicting-effect" };
    }
    if (!canTransitionReceipt(current.state, to)) return { ok: false, code: "invalid-transition" };
    const effectDigest = options.effectDigest ?? current.effectDigest;
    if ((to === "effect-published" || to === "accepted") && !effectDigest) {
      return { ok: false, code: "missing-effect-digest" };
    }
    if (options.diagnosticRef && current.diagnosticRefs.length >= MAX_DIAGNOSTIC_REFERENCES) {
      return { ok: false, code: "too-many-diagnostic-refs" };
    }

    const updated = await this.database.query<ReceiptRow>(
      `UPDATE forge_operation_receipts
       SET state = $1,
           record_version = record_version + 1,
           effect_digest = COALESCE($2, effect_digest),
           diagnostic_refs = CASE
             WHEN $3::text IS NULL THEN diagnostic_refs
             ELSE diagnostic_refs || jsonb_build_array($3::text)
           END,
           updated_at = NOW()
       WHERE run_id = $4 AND task_id = $5 AND logical_attempt = $6 AND operation_id = $7
         AND record_version = $8 AND state = $9
       RETURNING ${RECEIPT_COLUMNS}`,
      [to, effectDigest ?? null, options.diagnosticRef ?? null, ...keyValues(key), expectedVersion, current.state],
    );
    if (updated.rows[0]) {
      return { ok: true, receipt: toReceipt(updated.rows[0]), reused: false };
    }

    const latest = await this.get(key);
    return latest
      ? { ok: false, code: "stale-revision" }
      : { ok: false, code: "unknown-receipt" };
  }
}
