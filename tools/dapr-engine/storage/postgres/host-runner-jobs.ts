import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../../contract/v1/index.ts";
import type { HarnessRunnerRequestV1 } from "../../execution/runner-contract.ts";
import { parseHarnessRunnerRequest } from "../../execution/runner-contract.ts";
import type { SqlQueryable } from "./operation-receipts.ts";

export type HostRunnerJobState = "queued" | "leased" | "completed" | "failed" | "cancelled";

export interface HostRunnerJobV1 {
  readonly request: HarnessRunnerRequestV1;
  readonly state: HostRunnerJobState;
  readonly leaseId?: string;
  readonly cancelRequested: boolean;
  readonly result?: unknown;
  readonly errorMessage?: string;
}

export type HostRunnerEnqueueResult =
  | { readonly ok: true; readonly reused: boolean }
  | { readonly ok: false; readonly code: "request-conflict" };

export interface HostRunnerClaimV1 {
  readonly leaseId: string;
  readonly request: HarnessRunnerRequestV1;
}

interface HostRunnerJobRow extends Record<string, unknown> {
  schema_version: number;
  operation_id: string;
  repository_id: string;
  request_digest: string;
  request: unknown;
  state: HostRunnerJobState;
  lease_id: string | null;
  cancel_requested: boolean;
  result: unknown;
  error_message: string | null;
}

const SCHEMA_VERSION = 1;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COLUMNS = "schema_version, operation_id, repository_id, request_digest, request, state, lease_id, cancel_requested, result, error_message";
const JOB_COLUMNS = "job.schema_version, job.operation_id, job.repository_id, job.request_digest, job.request, job.state, job.lease_id, job.cancel_requested, job.result, job.error_message";

function requestDigest(request: HarnessRunnerRequestV1): string {
  return canonicalDigest(request);
}

function toJob(row: HostRunnerJobRow): HostRunnerJobV1 {
  if (row.schema_version !== SCHEMA_VERSION
    || !["queued", "leased", "completed", "failed", "cancelled"].includes(row.state)
    || typeof row.cancel_requested !== "boolean"
    || typeof row.request_digest !== "string") {
    throw new Error("Database returned an invalid host-runner job.");
  }
  const request = parseHarnessRunnerRequest(typeof row.request === "string" ? JSON.parse(row.request) : row.request);
  if (request.identity.operationId !== row.operation_id
    || request.repositoryId !== row.repository_id
    || requestDigest(request) !== row.request_digest) {
    throw new Error("Database returned a host-runner job with mismatched request identity or digest.");
  }
  return {
    request,
    state: row.state,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    cancelRequested: row.cancel_requested,
    ...(row.result === null ? {} : { result: typeof row.result === "string" ? JSON.parse(row.result) : row.result }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}

/** Durable dispatch state for the Dapr worker and launcher-managed host runner. */
export class PostgresHostRunnerJobStore {
  constructor(private readonly database: SqlQueryable) {}

  async enqueue(request: HarnessRunnerRequestV1): Promise<HostRunnerEnqueueResult> {
    const validated = parseHarnessRunnerRequest(request);
    const { identity } = validated;
    const inserted = await this.database.query<HostRunnerJobRow>(
      `INSERT INTO forge_host_runner_jobs
        (schema_version, operation_id, run_id, task_id, logical_attempt, repository_id,
         request_digest, request, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', NOW(), NOW())
       ON CONFLICT (operation_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        SCHEMA_VERSION,
        identity.operationId,
        identity.runId,
        identity.taskId,
        identity.logicalAttempt,
        validated.repositoryId,
        requestDigest(validated),
        JSON.stringify(validated),
      ],
    );
    if (inserted.rows[0]) return { ok: true, reused: false };
    const existing = await this.database.query<{ request_digest: string }>(
      "SELECT request_digest FROM forge_host_runner_jobs WHERE operation_id = $1",
      [identity.operationId],
    );
    if (!existing.rows[0]) throw new Error("Host-runner job conflicted but could not be read.");
    return existing.rows[0].request_digest === requestDigest(validated)
      ? { ok: true, reused: true }
      : { ok: false, code: "request-conflict" };
  }

  async claim(repositoryId: string, leaseMs: number): Promise<HostRunnerClaimV1 | undefined> {
    if (!REPOSITORY_ID.test(repositoryId)) throw new TypeError("Invalid host-runner repository ID.");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new RangeError("Host-runner lease must be at least one second.");
    await this.database.query(
      `UPDATE forge_host_runner_jobs
       SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE repository_id = $1 AND state = 'leased' AND cancel_requested = TRUE
         AND lease_expires_at <= NOW()`,
      [repositoryId],
    );
    const leaseId = randomUUID();
    const claimed = await this.database.query<HostRunnerJobRow>(
      `WITH candidate AS (
         SELECT operation_id
         FROM forge_host_runner_jobs
         WHERE repository_id = $1 AND cancel_requested = FALSE
           AND (state = 'queued' OR (state = 'leased' AND lease_expires_at <= NOW()))
         ORDER BY created_at, operation_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE forge_host_runner_jobs AS job
       SET state = 'leased', lease_id = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       FROM candidate
       WHERE job.operation_id = candidate.operation_id
       RETURNING ${JOB_COLUMNS}`,
      [repositoryId, leaseId, leaseMs],
    );
    const row = claimed.rows[0];
    if (!row) return undefined;
    const job = toJob(row);
    return { leaseId, request: job.request };
  }

  async heartbeat(operationId: string, leaseId: string, leaseMs: number): Promise<boolean> {
    this.validateLease(operationId, leaseId, leaseMs);
    const updated = await this.database.query<{ operation_id: string }>(
      `UPDATE forge_host_runner_jobs
       SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE operation_id = $1 AND lease_id = $2 AND state = 'leased' AND cancel_requested = FALSE
       RETURNING operation_id`,
      [operationId, leaseId, leaseMs],
    );
    return updated.rows.length === 1;
  }

  async getForRunner(
    operationId: string,
    repositoryId: string,
    leaseId: string,
  ): Promise<HostRunnerJobV1 | undefined> {
    this.validateIdentity(operationId, repositoryId);
    if (!OPERATION_ID.test(leaseId)) return undefined;
    const result = await this.database.query<HostRunnerJobRow>(
      `SELECT ${COLUMNS}
       FROM forge_host_runner_jobs
       WHERE operation_id = $1 AND repository_id = $2 AND lease_id = $3`,
      [operationId, repositoryId, leaseId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  async get(operationId: string): Promise<HostRunnerJobV1 | undefined> {
    if (!OPERATION_ID.test(operationId)) return undefined;
    const result = await this.database.query<HostRunnerJobRow>(
      `SELECT ${COLUMNS} FROM forge_host_runner_jobs WHERE operation_id = $1`,
      [operationId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  async complete(operationId: string, leaseId: string, result: unknown): Promise<boolean> {
    this.validateIdentity(operationId);
    if (!OPERATION_ID.test(leaseId)) return false;
    const updated = await this.database.query<{ state: HostRunnerJobState }>(
      `UPDATE forge_host_runner_jobs
       SET state = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
           result = CASE WHEN cancel_requested THEN NULL ELSE $3::jsonb END,
           error_message = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE operation_id = $1 AND lease_id = $2 AND state = 'leased'
       RETURNING state`,
      [operationId, leaseId, JSON.stringify(result)],
    );
    return updated.rows[0]?.state === "completed";
  }

  async fail(operationId: string, leaseId: string, message: string): Promise<boolean> {
    this.validateIdentity(operationId);
    if (!OPERATION_ID.test(leaseId)) return false;
    const updated = await this.database.query<{ state: HostRunnerJobState }>(
      `UPDATE forge_host_runner_jobs
       SET state = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
           error_message = CASE WHEN cancel_requested THEN NULL ELSE $3 END,
           result = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE operation_id = $1 AND lease_id = $2 AND state = 'leased'
       RETURNING state`,
      [operationId, leaseId, message.slice(0, 4000)],
    );
    return updated.rows[0]?.state === "failed";
  }

  async cancel(operationId: string): Promise<boolean> {
    this.validateIdentity(operationId);
    const updated = await this.database.query<{ operation_id: string }>(
      `UPDATE forge_host_runner_jobs
       SET state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
           cancel_requested = CASE WHEN state = 'leased' THEN TRUE ELSE cancel_requested END,
           lease_id = CASE WHEN state = 'queued' THEN NULL ELSE lease_id END,
           lease_expires_at = CASE WHEN state = 'queued' THEN NULL ELSE lease_expires_at END,
           updated_at = NOW()
       WHERE operation_id = $1 AND state IN ('queued', 'leased')
       RETURNING operation_id`,
      [operationId],
    );
    return updated.rows.length === 1;
  }

  private validateLease(operationId: string, leaseId: string, leaseMs: number): void {
    this.validateIdentity(operationId);
    if (!OPERATION_ID.test(leaseId)) throw new TypeError("Invalid host-runner lease ID.");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new RangeError("Host-runner lease must be at least one second.");
  }

  private validateIdentity(operationId: string, repositoryId?: string): void {
    if (!OPERATION_ID.test(operationId)) throw new TypeError("Invalid host-runner operation ID.");
    if (repositoryId !== undefined && !REPOSITORY_ID.test(repositoryId)) {
      throw new TypeError("Invalid host-runner repository ID.");
    }
  }
}
