import {
  decideCancel,
  decideExecutionLost,
  decideExecutionStart,
  decideHeartbeat,
  decideOutcomeAdmission,
  decideProcessExit,
  SCHEMA_VERSION,
  type ExecutionClaimV1,
  type ExecutionOwnershipRejection,
  type ExecutionStartRejection,
  type ExecutionState,
  type HeartbeatDirective,
  type OperationExecutionV1,
  type OperationKeyV1,
  type OutcomeAdmissionRejection,
  type ProcessExitV1,
  type Sha256Digest,
} from "../../contract/v1/index.ts";
import type { ExecutionOwnershipStore } from "../../execution/process-lifecycle.ts";
import { PostgresOperationReceiptStore, type ReceiptStoreResult, type SqlQueryable } from "./operation-receipts.ts";
import type { TransactionalSqlConnection, TransactionalSqlDatabase } from "./repository-integration.ts";

interface ExecutionRow extends Record<string, unknown> {
  schema_version: number;
  run_id: string;
  task_id: string;
  logical_attempt: number;
  operation_id: string;
  execution_epoch: string | number;
  worker_id: string;
  state: ExecutionState;
  deadline_at: Date | string;
  heartbeat_expires_at: Date | string;
  revision: string | number;
  cancel_reason: string | null;
  exit_record: ProcessExitV1 | string | null;
  lost_epochs: number[] | string;
}

const EXECUTION_COLUMNS = `
  schema_version, run_id, task_id, logical_attempt, operation_id, execution_epoch,
  worker_id, state, deadline_at, heartbeat_expires_at, revision, cancel_reason,
  exit_record, lost_epochs
`;
const KEY_PREDICATE = "run_id = $1 AND task_id = $2 AND logical_attempt = $3 AND operation_id = $4";

const keyValues = (key: OperationKeyV1): unknown[] => [key.runId, key.taskId, key.logicalAttempt, key.operationId];

function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Database returned an invalid ${name}: ${value}`);
  return parsed;
}

function isoString(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Database returned an invalid ${name}`);
  return date.toISOString();
}

function json<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function toExecution(row: ExecutionRow): OperationExecutionV1 {
  if (row.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported operation execution schema version: ${row.schema_version}`);
  const lostEpochs = json(row.lost_epochs);
  if (!Array.isArray(lostEpochs) || !lostEpochs.every((epoch) => Number.isSafeInteger(epoch) && epoch > 0)) {
    throw new Error("Database returned invalid lost execution epochs");
  }
  const exit = row.exit_record === null ? undefined : json(row.exit_record);
  return {
    schemaVersion: SCHEMA_VERSION,
    key: { runId: row.run_id, taskId: row.task_id, logicalAttempt: row.logical_attempt, operationId: row.operation_id },
    executionEpoch: safeInteger(row.execution_epoch, "execution epoch"),
    workerId: row.worker_id,
    state: row.state,
    deadlineAt: isoString(row.deadline_at, "execution deadline"),
    heartbeatExpiresAt: isoString(row.heartbeat_expires_at, "execution heartbeat expiry"),
    revision: safeInteger(row.revision, "execution revision"),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    ...(exit ? { exit } : {}),
    lostEpochs,
  };
}

function rowValues(execution: OperationExecutionV1): unknown[] {
  return [
    ...keyValues(execution.key),
    SCHEMA_VERSION,
    execution.executionEpoch,
    execution.workerId,
    execution.state,
    execution.deadlineAt,
    execution.heartbeatExpiresAt,
    execution.revision,
    execution.cancelReason ?? null,
    execution.exit ? JSON.stringify(execution.exit) : null,
    JSON.stringify(execution.lostEpochs),
  ];
}

async function transaction<T>(
  database: TransactionalSqlDatabase,
  operation: (connection: TransactionalSqlConnection) => Promise<{ readonly commit: boolean; readonly value: T }>,
): Promise<T> {
  const connection = await database.connect();
  let open = false;
  try {
    await connection.query("BEGIN");
    open = true;
    const { commit, value } = await operation(connection);
    open = false;
    await connection.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (error) {
    if (open) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Execution ownership update failed and could not be rolled back");
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function databaseNow(connection: SqlQueryable): Promise<number> {
  const result = await connection.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  const ms = now === undefined ? Number.NaN : new Date(now).getTime();
  if (!Number.isFinite(ms)) throw new Error("Database did not return a valid current time for execution ownership");
  return ms;
}

async function lockExecution(connection: SqlQueryable, key: OperationKeyV1): Promise<OperationExecutionV1 | undefined> {
  const result = await connection.query<ExecutionRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM forge_operation_executions WHERE ${KEY_PREDICATE} FOR UPDATE`,
    keyValues(key),
  );
  return result.rows[0] ? toExecution(result.rows[0]) : undefined;
}

/** Writes a decided record; the caller holds the row lock, or inserts the first epoch. */
async function writeExecution(connection: SqlQueryable, execution: OperationExecutionV1, inserting: boolean): Promise<boolean> {
  const result = inserting
    ? await connection.query(
        `INSERT INTO forge_operation_executions
          (run_id, task_id, logical_attempt, operation_id, schema_version, execution_epoch, worker_id, state,
           deadline_at, heartbeat_expires_at, revision, cancel_reason, exit_record, lost_epochs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
         ON CONFLICT (run_id, task_id, logical_attempt, operation_id) DO NOTHING
         RETURNING run_id`,
        rowValues(execution),
      )
    : await connection.query(
        `UPDATE forge_operation_executions
         SET schema_version = $5, execution_epoch = $6, worker_id = $7, state = $8, deadline_at = $9,
             heartbeat_expires_at = $10, revision = $11, cancel_reason = $12, exit_record = $13::jsonb,
             lost_epochs = $14::jsonb
         WHERE ${KEY_PREDICATE} AND revision = $11 - 1
         RETURNING run_id`,
        rowValues(execution),
      );
  return result.rows.length === 1;
}

async function update(connection: SqlQueryable, execution: OperationExecutionV1): Promise<void> {
  if (!(await writeExecution(connection, execution, false))) {
    throw new Error("Locked operation execution changed during its transaction");
  }
}

export interface OutcomePublication {
  readonly expectedReceiptVersion: number;
  /** `effect-published` for a produced effect, `failed` for a failed attempt. */
  readonly to: "effect-published" | "failed";
  readonly effectDigest?: Sha256Digest;
  readonly diagnosticRef?: string;
}

export type OutcomePublicationResult =
  | { readonly ok: true; readonly execution: OperationExecutionV1; readonly receipt: ReceiptStoreResult & { ok: true } }
  | { readonly ok: false; readonly code: OutcomeAdmissionRejection; readonly receiptFailed?: boolean }
  | { readonly ok: false; readonly code: "receipt-rejected"; readonly receipt: ReceiptStoreResult & { ok: false } };

export type ExecutionStartResult =
  | { readonly ok: true; readonly execution: OperationExecutionV1 }
  | { readonly ok: false; readonly code: ExecutionStartRejection; readonly execution?: OperationExecutionV1 };
export type ExecutionHeartbeatResult =
  | { readonly ok: true; readonly directive: HeartbeatDirective; readonly execution: OperationExecutionV1 }
  | { readonly ok: false; readonly code: ExecutionOwnershipRejection };
export type ExecutionExitResult =
  | { readonly ok: true; readonly execution: OperationExecutionV1 }
  | { readonly ok: false; readonly code: ExecutionOwnershipRejection };
export type ExecutionCancelResult =
  | { readonly ok: true; readonly execution: OperationExecutionV1; readonly reused: boolean }
  | { readonly ok: false; readonly code: "unknown-execution" | "outcome-published" };

export interface LostExecution {
  readonly execution: OperationExecutionV1;
  /** True when a cancelled execution's receipt was failed because its cleanup can no longer be observed. */
  readonly receiptFailed: boolean;
}

/**
 * PostgreSQL execution ownership. Every decision locks the execution row and
 * uses the database clock; outcome admission and the receipt transition commit
 * in one transaction, so a cancel or takeover serialized before it wins.
 */
export class PostgresExecutionOwnershipStore implements ExecutionOwnershipStore {
  constructor(private readonly database: TransactionalSqlDatabase) {}

  async get(key: OperationKeyV1): Promise<OperationExecutionV1 | undefined> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM forge_operation_executions WHERE ${KEY_PREDICATE}`,
        keyValues(key),
      );
      return result.rows[0] ? toExecution(result.rows[0]) : undefined;
    } finally {
      connection.release();
    }
  }

  async start(input: {
    readonly key: OperationKeyV1;
    readonly workerId: string;
    readonly budgetMs: number;
    readonly heartbeatTtlMs: number;
  }): Promise<ExecutionStartResult> {
    return transaction<ExecutionStartResult>(this.database, async (connection) => {
      // Lock order matches publishOutcome: execution row first, then the receipt.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await lockExecution(connection, input.key);
        const receipt = await connection.query<{ state: string }>(
          `SELECT state FROM forge_operation_receipts WHERE ${KEY_PREDICATE}`,
          keyValues(input.key),
        );
        if (receipt.rows[0]?.state !== "executing") {
          return { commit: false, value: { ok: false, code: "receipt-not-executing", ...(current ? { execution: current } : {}) } as const };
        }
        const decision = decideExecutionStart(current, { ...input, nowMs: await databaseNow(connection) });
        if (!decision.ok) return { commit: false, value: decision };
        if (current) {
          await update(connection, decision.execution);
          return { commit: true, value: decision };
        }
        if (await writeExecution(connection, decision.execution, true)) return { commit: true, value: decision };
        // A concurrent first start inserted the row; decide again under its lock.
      }
      throw new Error("Operation execution could not be started after a concurrent insert");
    });
  }

  async heartbeat(key: OperationKeyV1, claim: ExecutionClaimV1, heartbeatTtlMs: number): Promise<ExecutionHeartbeatResult> {
    return transaction<ExecutionHeartbeatResult>(this.database, async (connection) => {
      const decision = decideHeartbeat(await lockExecution(connection, key), claim, {
        nowMs: await databaseNow(connection),
        heartbeatTtlMs,
      });
      if (!decision.ok) return { commit: false, value: { ok: false, code: decision.code } as const };
      await update(connection, decision.execution);
      return { commit: true, value: { ok: true, directive: decision.directive ?? "continue", execution: decision.execution } as const };
    });
  }

  async recordExit(key: OperationKeyV1, claim: ExecutionClaimV1, exit: Omit<ProcessExitV1, "observedAt">): Promise<ExecutionExitResult> {
    return transaction<ExecutionExitResult>(this.database, async (connection) => {
      const decision = decideProcessExit(await lockExecution(connection, key), claim, exit, await databaseNow(connection));
      if (!decision.ok) return { commit: false, value: { ok: false, code: decision.code } as const };
      if (!decision.reused) await update(connection, decision.execution);
      return { commit: !decision.reused, value: { ok: true, execution: decision.execution } as const };
    });
  }

  /**
   * Records a cancellation request. Acceptance is not evidence that the
   * process stopped: the owner observes it on its next heartbeat and reports exit.
   */
  async requestCancel(key: OperationKeyV1, reason: string): Promise<ExecutionCancelResult> {
    return transaction<ExecutionCancelResult>(this.database, async (connection) => {
      const decision = decideCancel(await lockExecution(connection, key), reason);
      if (!decision.ok) return { commit: false, value: { ok: false, code: decision.code } as const };
      if (!decision.reused) await update(connection, decision.execution);
      return { commit: !decision.reused, value: { ok: true, execution: decision.execution, reused: decision.reused === true } as const };
    });
  }

  /**
   * Admits the owner's outcome and applies its receipt transition atomically.
   * A cancelled execution's outcome is rejected as `late-result` and its
   * still-executing receipt fails, preserving the caller's diagnostic. A stale
   * or lost epoch never touches the receipt that a newer owner holds.
   */
  async publishOutcome(key: OperationKeyV1, claim: ExecutionClaimV1, publication: OutcomePublication): Promise<OutcomePublicationResult> {
    return transaction(this.database, async (connection): Promise<{ commit: boolean; value: OutcomePublicationResult }> => {
      const decision = decideOutcomeAdmission(
        await lockExecution(connection, key),
        claim,
        publication.to === "effect-published" ? "effect" : "failure",
      );
      const receipts = new PostgresOperationReceiptStore(connection);
      if (!decision.ok) {
        if (decision.code !== "late-result") return { commit: false, value: { ok: false, code: decision.code } };
        const failed = await receipts.transition(key, publication.expectedReceiptVersion, "failed", {
          diagnosticRef: publication.diagnosticRef ?? `execution:late-result:epoch-${claim.executionEpoch}`,
        });
        return { commit: failed.ok, value: { ok: false, code: "late-result", receiptFailed: failed.ok } };
      }
      const receipt = await receipts.transition(key, publication.expectedReceiptVersion, publication.to, {
        ...(publication.effectDigest ? { effectDigest: publication.effectDigest } : {}),
        ...(publication.diagnosticRef ? { diagnosticRef: publication.diagnosticRef } : {}),
      });
      if (!receipt.ok) return { commit: false, value: { ok: false, code: "receipt-rejected", receipt } };
      await update(connection, decision.execution);
      return { commit: true, value: { ok: true, execution: decision.execution, receipt } };
    });
  }

  /**
   * Fences executions whose owner stopped renewing its heartbeat (worker loss).
   * A lost running epoch stays redeliverable: the next start takes over with a
   * larger epoch and the original deadline. A lost cancelled epoch fails its
   * executing receipt because its process cleanup can no longer be observed.
   */
  async fenceLostExecutions(limit = 100): Promise<LostExecution[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Lost execution limit must be between 1 and 1000");
    }
    return transaction(this.database, async (connection) => {
      const expired = await connection.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM forge_operation_executions
         WHERE state IN ('running', 'cancel-requested') AND heartbeat_expires_at <= clock_timestamp()
         ORDER BY heartbeat_expires_at, run_id, task_id, logical_attempt, operation_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const nowMs = await databaseNow(connection);
      const receipts = new PostgresOperationReceiptStore(connection);
      const lost: LostExecution[] = [];
      for (const row of expired.rows) {
        const current = toExecution(row);
        const decision = decideExecutionLost(current, nowMs);
        if (!decision.ok) continue;
        await update(connection, decision.execution);
        let receiptFailed = false;
        if (current.cancelReason !== undefined) {
          const receipt = await receipts.get(current.key);
          if (receipt?.state === "executing") {
            const failed = await receipts.transition(current.key, receipt.recordVersion, "failed", {
              diagnosticRef: `execution:cancelled-worker-lost:epoch-${current.executionEpoch}:cleanup-unconfirmed`,
            });
            receiptFailed = failed.ok;
          }
        }
        lost.push({ execution: decision.execution, receiptFailed });
      }
      return { commit: true, value: lost };
    });
  }
}
