import {
  canonicalDigest,
  SCHEMA_VERSION,
  type AttemptStatusV1,
  type JsonValue,
  type RunLifecycleEventInputV1,
  type RunLifecycleEventPageV1,
  type RunLifecycleEventV1,
  type RunLifecycleEventTypeV1,
  type RunStatusCreateV1,
  type RunStatusIdentityV1,
  type RunStatusSnapshotV1,
  type Sha256Digest,
  type TaskAttemptStatusV1,
  type TaskAttemptStatusResponseV1,
  type TaskStatusResponseV1,
  type TaskStatusSnapshotV1,
} from "../../contract/v1/index.ts";
import type { RunStatusV1, TaskStatusV1 } from "../../contract/v1/types.ts";
import type { SqlQueryable } from "./operation-receipts.ts";
import type { TransactionalSqlConnection, TransactionalSqlDatabase } from "./repository-integration.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EVENT_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,256}$/;
const MAX_DETAIL_BYTES = 64 * 1024;
const EVENT_TYPES: readonly RunLifecycleEventTypeV1[] = [
  "run.created", "run.started", "run.pausing", "run.paused", "run.stopping",
  "run.stopped", "run.cancelling", "run.cancelled", "run.completed", "run.failed",
  "run.reopened", "run.resumed", "attempt.started", "attempt.waiting-for-approval",
  "attempt.resumed", "attempt.failed", "task.completed", "task.failed", "task.skipped",
  "task.cancelled", "task.replayed",
];

interface RunRow extends Record<string, unknown> {
  schema_version: number;
  run_id: string;
  repository_id: string;
  target_ref: string;
  manifest_digest: string;
  status: RunStatusV1;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunSnapshotRow extends RunRow {
  observed_at: Date | string;
}

interface TaskRow extends Record<string, unknown> {
  task_id: string;
  task_index: number;
  status: TaskStatusV1;
  logical_attempt: string | number | null;
  updated_at: Date | string;
  observed_at?: Date | string;
}

interface AttemptRow extends Record<string, unknown> {
  task_id: string;
  logical_attempt: string | number;
  status: AttemptStatusV1;
  updated_at: Date | string;
  observed_at?: Date | string;
}

interface EventRow extends Record<string, unknown> {
  schema_version: number;
  run_id: string;
  sequence: string | number;
  event_key: string;
  event_type: string;
  task_id: string | null;
  logical_attempt: string | number | null;
  run_status: RunStatusV1 | null;
  task_status: TaskStatusV1 | null;
  attempt_status: AttemptStatusV1 | null;
  detail: Record<string, JsonValue> | string;
  created_at: Date | string;
}

const RUN_COLUMNS = `
  schema_version, run_id, repository_id, target_ref, manifest_digest,
  status, revision, created_at, updated_at
`;
const EVENT_COLUMNS = `
  schema_version, run_id, sequence, event_key, event_type, task_id,
  logical_attempt, run_status, task_status, attempt_status, detail, created_at
`;

function safeInteger(value: string | number, field: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Database returned an invalid ${field}: ${value}`);
  }
  return parsed;
}

function isoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Database returned an invalid ${field} timestamp`);
  return parsed.toISOString();
}

function parseJson<T>(value: T | string, field: string): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Database returned invalid ${field} JSON`);
  }
}

function validateCreate(input: RunStatusCreateV1): void {
  if (!input || input.schemaVersion !== SCHEMA_VERSION
    || typeof input.runId !== "string" || !input.runId
    || typeof input.repositoryId !== "string" || !input.repositoryId
    || typeof input.targetRef !== "string" || !input.targetRef
    || typeof input.manifestDigest !== "string" || !DIGEST_PATTERN.test(input.manifestDigest)) {
    throw new TypeError("Run status creation requires v1 run, repository, target, and manifest identities");
  }
  if (!Array.isArray(input.taskIds) || input.taskIds.some((taskId) =>
    typeof taskId !== "string" || !taskId || taskId.length > 256) ||
    new Set(input.taskIds).size !== input.taskIds.length) {
    throw new TypeError("Run status creation requires unique non-empty task IDs");
  }
}

function validateEvent(input: RunLifecycleEventInputV1): void {
  if (!input || input.schemaVersion !== SCHEMA_VERSION
    || typeof input.runId !== "string" || !input.runId
    || typeof input.eventKey !== "string" || !EVENT_KEY_PATTERN.test(input.eventKey)
    || !EVENT_TYPES.includes(input.eventType)) {
    throw new TypeError("Lifecycle event requires v1, run identity, event key, and event type");
  }
  if ((input.eventType.startsWith("run.") && input.runStatus === undefined)
    || (input.eventType.startsWith("task.") && input.taskStatus === undefined)
    || (input.eventType.startsWith("attempt.") && input.attemptStatus === undefined)) {
    throw new TypeError("Lifecycle event type requires its matching status field");
  }
  if (input.taskId !== undefined &&
    (typeof input.taskId !== "string" || !input.taskId || input.taskId.length > 256)) {
    throw new TypeError("Lifecycle event task ID must be a non-empty string of at most 256 characters");
  }
  if (input.logicalAttempt !== undefined &&
    (!Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1)) {
    throw new TypeError("Lifecycle event logical attempt must be a positive safe integer");
  }
  if ((input.taskStatus !== undefined || input.attemptStatus !== undefined) && !input.taskId) {
    throw new TypeError("Task and attempt status events require a task ID");
  }
  if (input.attemptStatus !== undefined && input.logicalAttempt === undefined) {
    throw new TypeError("Attempt status events require a logical attempt");
  }
  if (
    input.runStatus === undefined && input.taskStatus === undefined && input.attemptStatus === undefined
  ) {
    throw new TypeError("Lifecycle event must change at least one status");
  }
  const detail = input.detail ?? {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail)
    || Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_DETAIL_BYTES) {
    throw new RangeError(`Lifecycle event detail must be an object no larger than ${MAX_DETAIL_BYTES} bytes`);
  }
}

function toRunRow(row: RunSnapshotRow): Omit<RunStatusSnapshotV1, "tasks"> {
  if (row.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported run status schema version: ${row.schema_version}`);
  if (!DIGEST_PATTERN.test(row.manifest_digest)) throw new Error("Database returned an invalid run manifest digest");
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: row.run_id,
    repositoryId: row.repository_id,
    targetRef: row.target_ref,
    manifestDigest: row.manifest_digest as Sha256Digest,
    status: row.status,
    revision: safeInteger(row.revision, "run revision", 1),
    createdAt: isoTimestamp(row.created_at, "run creation"),
    updatedAt: isoTimestamp(row.updated_at, "run update"),
    observedAt: isoTimestamp(row.observed_at, "status observation"),
  };
}

function toRunIdentity(run: Omit<RunStatusSnapshotV1, "tasks">): RunStatusIdentityV1 {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    repositoryId: run.repositoryId,
    targetRef: run.targetRef,
    manifestDigest: run.manifestDigest,
    status: run.status,
    revision: run.revision,
    observedAt: run.observedAt,
  };
}

function toTask(row: TaskRow, attempts: readonly TaskAttemptStatusV1[]): TaskStatusSnapshotV1 {
  return {
    taskId: row.task_id,
    status: row.status,
    ...(row.logical_attempt === null ? {} : {
      logicalAttempt: safeInteger(row.logical_attempt, "task logical attempt", 1),
    }),
    attempts,
    updatedAt: isoTimestamp(row.updated_at, "task update"),
    observedAt: isoTimestamp(row.observed_at ?? row.updated_at, "task status observation"),
  };
}

function toEvent(row: EventRow): RunLifecycleEventV1 {
  if (row.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported lifecycle event schema version: ${row.schema_version}`);
  const sequence = safeInteger(row.sequence, "event sequence", 1);
  const detail = parseJson(row.detail, "lifecycle event detail");
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("Database returned an invalid lifecycle event detail");
  }
  if (!EVENT_TYPES.includes(row.event_type as RunLifecycleEventTypeV1)) {
    throw new Error(`Database returned an unsupported lifecycle event type: ${row.event_type}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: row.run_id,
    sequence,
    eventKey: row.event_key,
    eventType: row.event_type as RunLifecycleEventTypeV1,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.logical_attempt === null ? {} : {
      logicalAttempt: safeInteger(row.logical_attempt, "event logical attempt", 1),
    }),
    ...(row.run_status === null ? {} : { runStatus: row.run_status }),
    ...(row.task_status === null ? {} : { taskStatus: row.task_status }),
    ...(row.attempt_status === null ? {} : { attemptStatus: row.attempt_status }),
    detail: detail as Readonly<Record<string, JsonValue>>,
    createdAt: isoTimestamp(row.created_at, "event creation"),
  };
}

function validRunTransition(from: RunStatusV1, to: RunStatusV1): boolean {
  const transitions: Readonly<Record<RunStatusV1, readonly RunStatusV1[]>> = {
    queued: ["running", "cancelling", "cancelled", "failed"],
    running: ["running", "pausing", "paused", "stopping", "cancelling", "complete", "failed", "cancelled"],
    pausing: ["paused", "running", "stopping", "cancelling", "failed", "cancelled"],
    paused: ["running", "stopping", "cancelling", "cancelled", "failed"],
    stopping: ["paused", "running", "cancelling", "failed", "cancelled"],
    cancelling: ["cancelled", "failed"],
    complete: ["running"],
    failed: ["running"],
    cancelled: [],
  };
  return transitions[from].includes(to);
}

function validTaskTransition(from: TaskStatusV1, to: TaskStatusV1): boolean {
  const transitions: Readonly<Record<TaskStatusV1, readonly TaskStatusV1[]>> = {
    pending: ["ready", "running", "skipped", "cancelled"],
    ready: ["running", "skipped", "cancelled", "pending"],
    running: ["running", "waiting-for-approval", "complete", "failed", "skipped", "cancelled", "pending"],
    "waiting-for-approval": ["running", "failed", "cancelled"],
    complete: ["pending"],
    // A run cancellation supersedes a task failure that raced with it.
    failed: ["pending", "cancelled"],
    skipped: ["pending"],
    cancelled: ["pending"],
  };
  return transitions[from].includes(to);
}

/**
 * A task attempt still running when its run is cancelled can report an outcome
 * (or a retry) after the run has recorded the task as cancelled. The event is
 * kept for audit, but it must not reopen the cancelled task.
 */
function isLateCancelledTaskOutcome(run: RunStatusV1, task: TaskStatusV1, to: TaskStatusV1 | undefined): boolean {
  return (run === "cancelling" || run === "cancelled") && task === "cancelled" && to !== undefined;
}

function validAttemptTransition(from: AttemptStatusV1, to: AttemptStatusV1): boolean {
  const transitions: Readonly<Record<AttemptStatusV1, readonly AttemptStatusV1[]>> = {
    running: ["running", "waiting-for-approval", "complete", "failed", "skipped", "cancelled"],
    "waiting-for-approval": ["running", "complete", "failed", "skipped", "cancelled"],
    complete: [],
    failed: [],
    skipped: [],
    cancelled: [],
  };
  return transitions[from].includes(to);
}

async function inTransaction<T>(
  database: TransactionalSqlDatabase,
  operation: (connection: TransactionalSqlConnection) => Promise<T>,
): Promise<T> {
  const connection = await database.connect();
  let started = false;
  try {
    await connection.query("BEGIN");
    started = true;
    const result = await operation(connection);
    await connection.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Run status transaction failed and could not be rolled back");
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function findEvent(
  database: SqlQueryable,
  runId: string,
  eventKey: string,
): Promise<RunLifecycleEventV1 | undefined> {
  const result = await database.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM forge_run_events WHERE run_id = $1 AND event_key = $2`,
    [runId, eventKey],
  );
  return result.rows[0] ? toEvent(result.rows[0]) : undefined;
}

function eventDigest(event: RunLifecycleEventInputV1): string {
  return canonicalDigest({
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    eventKey: event.eventKey,
    eventType: event.eventType,
    taskId: event.taskId ?? null,
    logicalAttempt: event.logicalAttempt ?? null,
    runStatus: event.runStatus ?? null,
    taskStatus: event.taskStatus ?? null,
    attemptStatus: event.attemptStatus ?? null,
    detail: event.detail ?? {},
  });
}

function eventMatches(input: RunLifecycleEventInputV1, existing: RunLifecycleEventV1): boolean {
  return eventDigest(input) === eventDigest({
    schemaVersion: existing.schemaVersion,
    runId: existing.runId,
    eventKey: existing.eventKey,
    eventType: existing.eventType,
    ...(existing.taskId === undefined ? {} : { taskId: existing.taskId }),
    ...(existing.logicalAttempt === undefined ? {} : { logicalAttempt: existing.logicalAttempt }),
    ...(existing.runStatus === undefined ? {} : { runStatus: existing.runStatus }),
    ...(existing.taskStatus === undefined ? {} : { taskStatus: existing.taskStatus }),
    ...(existing.attemptStatus === undefined ? {} : { attemptStatus: existing.attemptStatus }),
    ...(existing.detail === undefined ? {} : { detail: existing.detail }),
  });
}

export class PostgresRunStatusStore {
  constructor(private readonly database: TransactionalSqlDatabase & SqlQueryable) {}

  async createRun(input: RunStatusCreateV1): Promise<{ readonly runId: string; readonly reused: boolean }> {
    validateCreate(input);
    return inTransaction(this.database, async (connection) => {
      const inserted = await connection.query<RunRow>(
        `INSERT INTO forge_run_statuses
          (schema_version, run_id, repository_id, target_ref, manifest_digest,
           status, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'queued', 1, NOW(), NOW())
         ON CONFLICT (run_id) DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [SCHEMA_VERSION, input.runId, input.repositoryId, input.targetRef, input.manifestDigest],
      );
      if (!inserted.rows[0]) {
        const current = await connection.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM forge_run_statuses WHERE run_id = $1 FOR UPDATE`,
          [input.runId],
        );
        const row = current.rows[0];
        if (!row) throw new Error("Run registration conflicted but the existing status could not be read");
        const existingTasks = await connection.query<TaskRow>(
          `SELECT task_id, task_index, status, logical_attempt, updated_at
           FROM forge_run_tasks WHERE run_id = $1 ORDER BY task_index`,
          [input.runId],
        );
        const sameIdentity = row.repository_id === input.repositoryId
          && row.target_ref === input.targetRef
          && row.manifest_digest === input.manifestDigest;
        const sameTasks = existingTasks.rows.length === input.taskIds.length
          && existingTasks.rows.every((task, index) => task.task_id === input.taskIds[index]);
        if (!sameIdentity || !sameTasks) throw new Error("Run status identity conflicts with its existing snapshot");
        return { runId: input.runId, reused: true };
      }

      for (const [taskIndex, taskId] of input.taskIds.entries()) {
        await connection.query(
          `INSERT INTO forge_run_tasks (run_id, task_id, task_index, status, updated_at)
           VALUES ($1, $2, $3, 'pending', NOW())`,
          [input.runId, taskId, taskIndex],
        );
      }
      await connection.query(
        `INSERT INTO forge_run_events
          (schema_version, run_id, sequence, event_key, event_type, run_status, detail, created_at)
         VALUES ($1, $2, 1, 'run.created', 'run.created', 'queued', '{}'::jsonb, NOW())`,
        [SCHEMA_VERSION, input.runId],
      );
      return { runId: input.runId, reused: false };
    });
  }

  async appendEvent(input: RunLifecycleEventInputV1): Promise<{ readonly event: RunLifecycleEventV1; readonly reused: boolean }> {
    validateEvent(input);
    return inTransaction(this.database, async (connection) => {
      const current = await connection.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM forge_run_statuses WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      const run = current.rows[0];
      if (!run) throw new Error(`Unknown run status record: ${input.runId}`);

      const duplicate = await findEvent(connection, input.runId, input.eventKey);
      if (duplicate) {
        if (!eventMatches(input, duplicate)) {
          throw new Error(`Lifecycle event key '${input.eventKey}' conflicts with its persisted event`);
        }
        return { event: duplicate, reused: true };
      }

      const revision = safeInteger(run.revision, "run revision", 1) + 1;
      if (!Number.isSafeInteger(revision)) throw new RangeError("Run status revision exceeds the safe integer range");
      if (input.runStatus !== undefined && !validRunTransition(run.status, input.runStatus)) {
        throw new Error(`Invalid run status transition: ${run.status} -> ${input.runStatus}`);
      }

      let task: TaskRow | undefined;
      let lateCancelledOutcome = false;
      if (input.taskId !== undefined) {
        const taskResult = await connection.query<TaskRow>(
          `SELECT task_id, task_index, status, logical_attempt, updated_at
           FROM forge_run_tasks WHERE run_id = $1 AND task_id = $2 FOR UPDATE`,
          [input.runId, input.taskId],
        );
        task = taskResult.rows[0];
        if (!task) throw new Error(`Unknown task status record: ${input.taskId}`);
        lateCancelledOutcome = isLateCancelledTaskOutcome(run.status, task.status, input.taskStatus);
        if (input.taskStatus !== undefined && !lateCancelledOutcome && !validTaskTransition(task.status, input.taskStatus)) {
          const oldAttempt = task.logical_attempt === null ? 0 : safeInteger(task.logical_attempt, "task logical attempt", 1);
          const newAttempt = input.logicalAttempt ?? oldAttempt;
          const isNewAttempt = input.taskStatus === "running" && newAttempt > oldAttempt
            && ["complete", "failed", "skipped", "cancelled"].includes(task.status);
          if (!isNewAttempt) throw new Error(`Invalid task status transition: ${task.status} -> ${input.taskStatus}`);
        }
        const oldAttempt = task.logical_attempt === null ? 0 : safeInteger(task.logical_attempt, "task logical attempt", 1);
        if (input.logicalAttempt !== undefined && input.logicalAttempt < oldAttempt) {
          throw new Error("Task status event cannot move the logical attempt backwards");
        }
      }

      let priorAttemptStatus: AttemptStatusV1 | undefined;
      if (input.attemptStatus !== undefined) {
        const attempt = await connection.query<AttemptRow>(
          `SELECT task_id, logical_attempt, status, updated_at FROM forge_run_attempts
           WHERE run_id = $1 AND task_id = $2 AND logical_attempt = $3 FOR UPDATE`,
          [input.runId, input.taskId!, input.logicalAttempt!],
        );
        priorAttemptStatus = attempt.rows[0]?.status;
        if (priorAttemptStatus && !validAttemptTransition(priorAttemptStatus, input.attemptStatus)) {
          throw new Error(`Invalid attempt status transition: ${priorAttemptStatus} -> ${input.attemptStatus}`);
        }
      }

      const inserted = await connection.query<EventRow>(
        `INSERT INTO forge_run_events
          (schema_version, run_id, sequence, event_key, event_type, task_id,
           logical_attempt, run_status, task_status, attempt_status, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
         RETURNING ${EVENT_COLUMNS}`,
        [
          SCHEMA_VERSION, input.runId, revision, input.eventKey, input.eventType,
          input.taskId ?? null, input.logicalAttempt ?? null, input.runStatus ?? null,
          input.taskStatus ?? null, input.attemptStatus ?? null, JSON.stringify(input.detail ?? {}),
        ],
      );
      if (!inserted.rows[0]) throw new Error("Database did not return the inserted lifecycle event");
      const event = toEvent(inserted.rows[0]);

      await connection.query(
        `UPDATE forge_run_statuses
         SET status = COALESCE($1, status), revision = $2, updated_at = $3
         WHERE run_id = $4`,
        [input.runStatus ?? null, revision, event.createdAt, input.runId],
      );

      if (input.taskId !== undefined && (input.taskStatus !== undefined || input.logicalAttempt !== undefined)) {
        await connection.query(
          `UPDATE forge_run_tasks
           SET status = COALESCE($1, status),
               logical_attempt = COALESCE($2, logical_attempt),
               updated_at = $3
           WHERE run_id = $4 AND task_id = $5`,
          [
            lateCancelledOutcome ? null : input.taskStatus ?? null, input.logicalAttempt ?? null, event.createdAt,
            input.runId, input.taskId,
          ],
        );
      }
      if (input.attemptStatus !== undefined) {
        await connection.query(
          `INSERT INTO forge_run_attempts
            (run_id, task_id, logical_attempt, status, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (run_id, task_id, logical_attempt)
           DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
          [input.runId, input.taskId!, input.logicalAttempt!, input.attemptStatus, event.createdAt],
        );
      }
      return { event, reused: false };
    });
  }

  /** IDs of runs whose projected status is not terminal, oldest first. */
  async listActiveRunIds(limit = 10_000): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const result = await this.database.query<{ run_id: string }>(
      `SELECT run_id FROM forge_run_statuses
       WHERE status NOT IN ('complete', 'failed', 'cancelled')
       ORDER BY updated_at, run_id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.run_id);
  }

  async getRunStatus(runId: string): Promise<RunStatusSnapshotV1 | undefined> {
    if (!runId) throw new TypeError("Run ID is required");
    return inTransaction(this.database, async (connection) => {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = await connection.query<RunSnapshotRow>(
        `SELECT ${RUN_COLUMNS}, clock_timestamp() AS observed_at
         FROM forge_run_statuses WHERE run_id = $1`,
        [runId],
      );
      const row = runResult.rows[0];
      if (!row) return undefined;
      const taskResult = await connection.query<TaskRow>(
        `SELECT task_id, task_index, status, logical_attempt, updated_at,
                clock_timestamp() AS observed_at
         FROM forge_run_tasks WHERE run_id = $1 ORDER BY task_index`,
        [runId],
      );
      const attemptResult = await connection.query<AttemptRow>(
        `SELECT task_id, logical_attempt, status, updated_at, clock_timestamp() AS observed_at
         FROM forge_run_attempts WHERE run_id = $1
         ORDER BY task_id, logical_attempt`,
        [runId],
      );
      const attemptsByTask = new Map<string, TaskAttemptStatusV1[]>();
      for (const attempt of attemptResult.rows) {
        const list = attemptsByTask.get(attempt.task_id) ?? [];
        list.push({
          taskId: attempt.task_id,
          logicalAttempt: safeInteger(attempt.logical_attempt, "attempt logical attempt", 1),
          status: attempt.status,
          updatedAt: isoTimestamp(attempt.updated_at, "attempt update"),
          observedAt: isoTimestamp(attempt.observed_at ?? attempt.updated_at, "attempt status observation"),
        });
        attemptsByTask.set(attempt.task_id, list);
      }
      return {
        ...toRunRow(row),
        tasks: taskResult.rows.map((task) => toTask(task, attemptsByTask.get(task.task_id) ?? [])),
      };
    });
  }

  async getTaskAttempt(
    runId: string,
    taskId: string,
    logicalAttempt: number,
  ): Promise<TaskAttemptStatusResponseV1 | undefined> {
    if (!runId || !taskId || !Number.isSafeInteger(logicalAttempt) || logicalAttempt < 1) {
      throw new TypeError("Attempt lookup requires run/task identities and a positive logical attempt");
    }
    return inTransaction(this.database, async (connection) => {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = await connection.query<RunSnapshotRow>(
        `SELECT ${RUN_COLUMNS}, clock_timestamp() AS observed_at
         FROM forge_run_statuses WHERE run_id = $1`,
        [runId],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return undefined;
      const attemptResult = await connection.query<AttemptRow>(
        `SELECT task_id, logical_attempt, status, updated_at, clock_timestamp() AS observed_at
         FROM forge_run_attempts
         WHERE run_id = $1 AND task_id = $2 AND logical_attempt = $3`,
        [runId, taskId, logicalAttempt],
      );
      const row = attemptResult.rows[0];
      if (!row) return undefined;
      const run = toRunRow(runRow);
      return {
        run: toRunIdentity(run),
        attempt: {
          taskId: row.task_id,
          logicalAttempt: safeInteger(row.logical_attempt, "attempt logical attempt", 1),
          status: row.status,
          updatedAt: isoTimestamp(row.updated_at, "attempt update"),
          observedAt: isoTimestamp(row.observed_at ?? row.updated_at, "attempt status observation"),
        },
      };
    });
  }

  async getTaskStatus(runId: string, taskId: string): Promise<TaskStatusResponseV1 | undefined> {
    if (!runId || !taskId) throw new TypeError("Task status lookup requires run and task identities");
    return inTransaction(this.database, async (connection) => {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runResult = await connection.query<RunSnapshotRow>(
        `SELECT ${RUN_COLUMNS}, clock_timestamp() AS observed_at
         FROM forge_run_statuses WHERE run_id = $1`,
        [runId],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return undefined;
      const taskResult = await connection.query<TaskRow>(
        `SELECT task_id, task_index, status, logical_attempt, updated_at,
                clock_timestamp() AS observed_at
         FROM forge_run_tasks WHERE run_id = $1 AND task_id = $2`,
        [runId, taskId],
      );
      const row = taskResult.rows[0];
      if (!row) return undefined;
      const attemptResult = await connection.query<AttemptRow>(
        `SELECT task_id, logical_attempt, status, updated_at, clock_timestamp() AS observed_at
         FROM forge_run_attempts WHERE run_id = $1 AND task_id = $2
         ORDER BY logical_attempt`,
        [runId, taskId],
      );
      const attempts = attemptResult.rows.map((attempt) => ({
        taskId: attempt.task_id,
        logicalAttempt: safeInteger(attempt.logical_attempt, "attempt logical attempt", 1),
        status: attempt.status,
        updatedAt: isoTimestamp(attempt.updated_at, "attempt update"),
        observedAt: isoTimestamp(attempt.observed_at ?? attempt.updated_at, "attempt status observation"),
      }));
      return {
        run: toRunIdentity(toRunRow(runRow)),
        task: toTask(row, attempts),
      };
    });
  }

  async listEvents(
    runId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<RunLifecycleEventPageV1> {
    if (!runId) throw new TypeError("Run ID is required");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("Event cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Event page size must be between 1 and 1000");
    }
    const run = await this.database.query<{ run_id: string }>(
      "SELECT run_id FROM forge_run_statuses WHERE run_id = $1",
      [runId],
    );
    if (!run.rows[0]) throw new Error(`Unknown run status record: ${runId}`);
    const result = await this.database.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM forge_run_events
       WHERE run_id = $1 AND sequence > $2
       ORDER BY sequence
       LIMIT $3`,
      [runId, afterSequence, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const events = rows.map(toEvent);
    return {
      events,
      cursor: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
    };
  }

  async *watchEvents(
    runId: string,
    afterSequence = 0,
    options: {
      readonly signal?: AbortSignal;
      readonly pollIntervalMs?: number;
      readonly pageSize?: number;
    } = {},
  ): AsyncGenerator<RunLifecycleEventV1> {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const pageSize = options.pageSize ?? 100;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 30_000) {
      throw new RangeError("Event polling interval must be between 50 and 30000 milliseconds");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new RangeError("Event page size must be between 1 and 1000");
    }
    let cursor = afterSequence;
    while (!options.signal?.aborted) {
      const page = await this.listEvents(runId, cursor, pageSize);
      if (page.events.length === 0) {
        await waitForPoll(pollIntervalMs, options.signal);
        continue;
      }
      for (const event of page.events) {
        if (options.signal?.aborted) return;
        cursor = event.sequence;
        yield event;
      }
    }
  }
}

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
