import type { AcceptedRunSubmissionV1 } from "../../orchestration/planner.ts";
import type { Sha256Digest } from "../../contract/v1/index.ts";
import type { SqlQueryable } from "./operation-receipts.ts";

export interface StoredRunSubmissionV1 {
  readonly runId: string;
  readonly submissionKey: string;
  readonly snapshotDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly submission: AcceptedRunSubmissionV1;
  readonly createdAt: string;
}

export type RunSubmissionCreateResult =
  | { readonly ok: true; readonly record: StoredRunSubmissionV1; readonly reused: boolean }
  | { readonly ok: false; readonly code: "submission-conflict" };

interface SubmissionRow extends Record<string, unknown> {
  run_id: string;
  submission_key: string;
  snapshot_digest: string;
  repository_id: string;
  submission: AcceptedRunSubmissionV1 | string;
  created_at: Date | string;
}

const COLUMNS = "run_id, submission_key, snapshot_digest, repository_id, submission, created_at";
const RUN_ID = /^run_[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: SubmissionRow): StoredRunSubmissionV1 {
  return {
    runId: row.run_id,
    submissionKey: row.submission_key,
    snapshotDigest: row.snapshot_digest as Sha256Digest,
    repositoryId: row.repository_id,
    submission: typeof row.submission === "string" ? JSON.parse(row.submission) : row.submission,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Durable accepted submissions; the service rebinds runs from these on restart. */
export class PostgresRunSubmissionStore {
  constructor(private readonly database: SqlQueryable) {}

  async create(input: {
    readonly runId: string;
    readonly snapshotDigest: Sha256Digest;
    readonly submission: AcceptedRunSubmissionV1;
  }): Promise<RunSubmissionCreateResult> {
    if (!RUN_ID.test(input.runId)) throw new TypeError("Run IDs must match run_<32 hex>");
    const inserted = await this.database.query<SubmissionRow>(
      `INSERT INTO forge_run_submissions
        (schema_version, submission_key, run_id, snapshot_digest, repository_id, submission, created_at)
       VALUES (1, $1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (submission_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.submission.submissionKey, input.runId, input.snapshotDigest,
        input.submission.repositoryId, JSON.stringify(input.submission),
      ],
    );
    if (inserted.rows[0]) return { ok: true, record: toRecord(inserted.rows[0]), reused: false };
    const existing = await this.getBySubmissionKey(input.submission.submissionKey);
    if (!existing) throw new Error("Run submission conflicted but the existing record could not be read");
    return existing.snapshotDigest === input.snapshotDigest
      ? { ok: true, record: existing, reused: true }
      : { ok: false, code: "submission-conflict" };
  }

  async get(runId: string): Promise<StoredRunSubmissionV1 | undefined> {
    if (!RUN_ID.test(runId)) return undefined;
    const result = await this.database.query<SubmissionRow>(
      `SELECT ${COLUMNS} FROM forge_run_submissions WHERE run_id = $1`,
      [runId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async getBySubmissionKey(submissionKey: string): Promise<StoredRunSubmissionV1 | undefined> {
    const result = await this.database.query<SubmissionRow>(
      `SELECT ${COLUMNS} FROM forge_run_submissions WHERE submission_key = $1`,
      [submissionKey],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  /** Newest first. */
  async list(limit: number, repositoryId?: string): Promise<readonly StoredRunSubmissionV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("Run submission listing requires a limit from 1 to 10000");
    }
    const result = await this.database.query<SubmissionRow>(
      `SELECT ${COLUMNS} FROM forge_run_submissions
       WHERE ($2::text IS NULL OR repository_id = $2)
       ORDER BY created_at DESC, run_id
       LIMIT $1`,
      [limit, repositoryId ?? null],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Allocates the replay attempt for one control exactly once: the next
   * logical attempt after every receipt, status, and earlier allocation.
   */
  async allocateReplayAttempt(controlId: string, runId: string, taskId: string): Promise<number> {
    if (!UUID.test(controlId) || !RUN_ID.test(runId) || !taskId) {
      throw new TypeError("Replay allocation requires a control UUID, run ID, and task ID");
    }
    const existing = async (): Promise<number | undefined> => {
      const result = await this.database.query<{ logical_attempt: number }>(
        "SELECT logical_attempt FROM forge_replay_allocations WHERE control_id = $1 AND run_id = $2 AND task_id = $3",
        [controlId, runId, taskId],
      );
      return result.rows[0]?.logical_attempt;
    };
    const prior = await existing();
    if (prior !== undefined) return prior;
    const inserted = await this.database.query<{ logical_attempt: number }>(
      `INSERT INTO forge_replay_allocations (control_id, run_id, task_id, logical_attempt, created_at)
       SELECT $1, $2, $3, GREATEST(
         1,
         COALESCE((SELECT MAX(logical_attempt) FROM forge_operation_receipts WHERE run_id = $2 AND task_id = $3), 1),
         COALESCE((SELECT logical_attempt FROM forge_run_tasks WHERE run_id = $2 AND task_id = $3), 1),
         COALESCE((SELECT MAX(logical_attempt) FROM forge_replay_allocations WHERE run_id = $2 AND task_id = $3), 1)
       ) + 1, NOW()
       ON CONFLICT (control_id) DO NOTHING
       RETURNING logical_attempt`,
      [controlId, runId, taskId],
    );
    const allocated = inserted.rows[0]?.logical_attempt ?? await existing();
    if (allocated === undefined) throw new Error(`Replay control '${controlId}' belongs to a different run or task`);
    return allocated;
  }
}
