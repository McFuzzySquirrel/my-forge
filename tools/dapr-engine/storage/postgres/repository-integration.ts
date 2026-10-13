import { runCommand } from "../../execution/harness/run.ts";
import { SCHEMA_VERSION, type FencingLeaseV1 } from "../../contract/v1/index.ts";
import type { SqlQueryable } from "./operation-receipts.ts";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const INTEGRATION_LEASE_GRACE_MS = GIT_TIMEOUT_MS + 5_000;

export interface TransactionalSqlConnection extends SqlQueryable {
  release(): void;
}

export interface TransactionalSqlDatabase {
  connect(): Promise<TransactionalSqlConnection>;
}

export type LeaseResult =
  | { readonly ok: true; readonly lease: FencingLeaseV1 }
  | { readonly ok: false; readonly code: "lease-held" };

export interface RepositoryIntegrationRequest {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly fencingToken: number;
  readonly runId: string;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly expectedHead: string;
  readonly commitSha: string;
}

export type RepositoryIntegrationResult =
  | { readonly ok: true; readonly commitSha: string; readonly reused: boolean }
  | {
      readonly ok: false;
      readonly code:
        | "no-lease"
        | "stale-fencing-token"
        | "expired-fencing-token"
        | "wrong-owner"
        | "conflicting-integration"
        | "expected-head-mismatch";
    };

export interface GitRefUpdater {
  update(
    repositoryRoot: string,
    targetRef: string,
    newObject: string,
    expectedOldObject: string,
  ): Promise<boolean>;
}

export type RepositoryRootResolver = (repositoryId: string) => string | undefined | Promise<string | undefined>;

interface FenceRow extends Record<string, unknown> {
  schema_version: number;
  repository_id: string;
  target_ref: string;
  fencing_token: string | number;
  owner_run_id: string | null;
  expires_at: Date | string | null;
  revision: string | number;
}

interface IntegrationRow extends Record<string, unknown> {
  commit_sha: string;
}

function safeInteger(value: string | number, label: string, minimum = 1): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Database returned an invalid ${label}: ${value}`);
  }
  return parsed;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Database returned an invalid repository lease timestamp");
  return date.toISOString();
}

function toLease(row: FenceRow): FencingLeaseV1 {
  if (row.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported repository fence schema version: ${row.schema_version}`);
  }
  if (!row.owner_run_id || !row.expires_at) {
    throw new Error("Database returned an unowned repository fence as an active lease");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repositoryId: row.repository_id,
    targetRef: row.target_ref,
    fencingToken: safeInteger(row.fencing_token, "repository fencing token"),
    ownerRunId: row.owner_run_id,
    expiresAt: toIsoString(row.expires_at),
    revision: safeInteger(row.revision, "repository fence revision"),
  };
}

function requireText(value: string, label: string): void {
  if (!value.trim() || value.includes("\0")) throw new TypeError(`${label} must be non-empty and contain no NUL characters`);
}

function validateScope(repositoryId: string, targetRef: string): void {
  requireText(repositoryId, "Repository ID");
  requireText(targetRef, "Target ref");
  if (!targetRef.startsWith("refs/heads/") || targetRef === "refs/heads/") {
    throw new TypeError("Repository integration only supports fully qualified branch refs");
  }
}

function validateRequest(request: RepositoryIntegrationRequest): void {
  validateScope(request.repositoryId, request.targetRef);
  requireText(request.runId, "Run ID");
  requireText(request.taskId, "Task ID");
  requireText(request.operationId, "Operation ID");
  if (!Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1) {
    throw new TypeError("Repository fencing token must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.logicalAttempt) || request.logicalAttempt < 1) {
    throw new TypeError("Logical attempt must be a positive safe integer");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.expectedHead)) {
    throw new TypeError("Expected repository head must be a full lowercase Git object ID");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.commitSha)) {
    throw new TypeError("Integrated commit must be a full lowercase Git object ID");
  }
  if (request.expectedHead.length !== request.commitSha.length) {
    throw new TypeError("Expected head and integrated commit must use the same Git object format");
  }
}

async function inTransaction<T>(
  database: TransactionalSqlDatabase,
  operation: (connection: TransactionalSqlConnection) => Promise<T>,
): Promise<T> {
  const connection = await database.connect();
  let transactionStarted = false;
  try {
    await connection.query("BEGIN");
    transactionStarted = true;
    const result = await operation(connection);
    await connection.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Repository integration failed and its PostgreSQL transaction could not be rolled back");
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

function gitError(action: string, result: { status: number | null; stdout: string; stderr: string; error?: string }): Error {
  const detail = (result.stderr || result.stdout || result.error || "").trim();
  return new Error(`${action} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`);
}

async function runGit(repositoryRoot: string, args: string[]) {
  return runCommand("git", args, {
    cwd: repositoryRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES,
  });
}

export class GitBranchRefUpdater implements GitRefUpdater {
  async update(
    repositoryRoot: string,
    targetRef: string,
    newObject: string,
    expectedOldObject: string,
  ): Promise<boolean> {
    const validRef = await runGit(repositoryRoot, ["check-ref-format", targetRef]);
    if (validRef.status !== 0) throw gitError("git check-ref-format", validRef);

    const commit = await runGit(repositoryRoot, ["cat-file", "-e", `${newObject}^{commit}`]);
    if (commit.status !== 0) throw gitError("git cat-file", commit);

    const current = await runGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`]);
    if (current.status === 1) return false;
    if (current.status !== 0) throw gitError("git rev-parse", current);
    if (current.stdout.trim() !== expectedOldObject) return false;

    const update = await runGit(repositoryRoot, ["update-ref", "--no-deref", targetRef, newObject, expectedOldObject]);
    if (update.status === 0) return true;

    const afterFailure = await runGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`]);
    if (afterFailure.status === 1) return false;
    if (afterFailure.status !== 0) {
      throw new GitRefMutationAmbiguousError(targetRef, gitError("git rev-parse after failed ref update", afterFailure));
    }
    const currentAfterFailure = afterFailure.stdout.trim();
    if (currentAfterFailure === newObject) return true;
    if (currentAfterFailure !== expectedOldObject) return false;
    throw gitError("git update-ref", update);
  }
}

export class GitRefMutationAmbiguousError extends Error {
  constructor(targetRef: string, cause: unknown) {
    super(`Git ref update outcome for ${targetRef} could not be determined; the ref requires reconciliation`, { cause });
    this.name = "GitRefMutationAmbiguousError";
  }
}

export class RepositoryIntegrationAmbiguousError extends Error {
  constructor(request: RepositoryIntegrationRequest, cause: unknown) {
    super(
      `Git ref or durable integration outcome is ambiguous for ${request.repositoryId}:${request.targetRef} `
        + `(${request.runId}/${request.taskId}/${request.logicalAttempt}); reconciliation is required`,
      { cause },
    );
    this.name = "RepositoryIntegrationAmbiguousError";
  }
}

export class PostgresRepositoryIntegrationAuthority {
  constructor(
    private readonly database: TransactionalSqlDatabase,
    private readonly resolveRepositoryRoot: RepositoryRootResolver,
    private readonly refUpdater: GitRefUpdater = new GitBranchRefUpdater(),
  ) {}

  async acquire(
    repositoryId: string,
    targetRef: string,
    runId: string,
    ttlMs: number,
  ): Promise<LeaseResult> {
    validateScope(repositoryId, targetRef);
    requireText(runId, "Run ID");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError("Repository lease TTL must be a positive safe integer number of milliseconds");
    }

    return inTransaction(this.database, async (connection) => {
      await connection.query(
        `INSERT INTO forge_repository_fences
          (schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision)
         VALUES ($1, $2, $3, 0, NULL, NULL, 0)
         ON CONFLICT (repository_id, target_ref) DO NOTHING`,
        [SCHEMA_VERSION, repositoryId, targetRef],
      );
      const locked = await connection.query<FenceRow>(
        `SELECT schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision
         FROM forge_repository_fences
         WHERE repository_id = $1 AND target_ref = $2
         FOR UPDATE`,
        [repositoryId, targetRef],
      );
      const current = locked.rows[0];
      if (!current) throw new Error("Repository fence row was inserted but could not be locked");
      if (current.schema_version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported repository fence schema version: ${current.schema_version}`);
      }

      const nowResult = await connection.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
      const now = nowResult.rows[0]?.now;
      if (now === undefined) throw new Error("Database did not return its current time for repository lease acquisition");
      const expiresAt = current.expires_at === null ? Number.NEGATIVE_INFINITY : new Date(current.expires_at).getTime();
      const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
      if (!Number.isFinite(nowMs)) throw new Error("Database returned an invalid current time for repository lease acquisition");
      if (current.owner_run_id && current.owner_run_id !== runId && expiresAt > nowMs) {
        return { ok: false, code: "lease-held" };
      }

      const granted = await connection.query<FenceRow>(
        `UPDATE forge_repository_fences
         SET fencing_token = fencing_token + 1,
             owner_run_id = $3,
             expires_at = clock_timestamp() + ($4::bigint * INTERVAL '1 millisecond'),
             revision = revision + 1
         WHERE repository_id = $1 AND target_ref = $2
         RETURNING schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision`,
        [repositoryId, targetRef, runId, ttlMs],
      );
      const lease = granted.rows[0];
      if (!lease) throw new Error("Repository lease update did not return its granted fence");
      return { ok: true, lease: toLease(lease) };
    });
  }

  async integrate(request: RepositoryIntegrationRequest): Promise<RepositoryIntegrationResult> {
    validateRequest(request);
    let gitUpdated = false;
    try {
      return await inTransaction(this.database, async (connection) => {
        const locked = await connection.query<FenceRow>(
          `SELECT schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision
           FROM forge_repository_fences
           WHERE repository_id = $1 AND target_ref = $2
           FOR UPDATE`,
          [request.repositoryId, request.targetRef],
        );
        const lease = locked.rows[0];
        if (!lease || !lease.owner_run_id || !lease.expires_at) return { ok: false, code: "no-lease" };
        if (lease.schema_version !== SCHEMA_VERSION) {
          throw new Error(`Unsupported repository fence schema version: ${lease.schema_version}`);
        }
        if (safeInteger(lease.fencing_token, "repository fencing token", 0) !== request.fencingToken) {
          return { ok: false, code: "stale-fencing-token" };
        }
        if (lease.owner_run_id !== request.runId) return { ok: false, code: "wrong-owner" };

        const nowResult = await connection.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
        const now = nowResult.rows[0]?.now;
        if (now === undefined) throw new Error("Database did not return its current time for repository integration");
        const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
        if (!Number.isFinite(nowMs)) throw new Error("Database returned an invalid current time for repository integration");
        if (new Date(lease.expires_at).getTime() <= nowMs) {
          return { ok: false, code: "expired-fencing-token" };
        }

        await connection.query(
          `UPDATE forge_repository_fences
           SET expires_at = GREATEST(expires_at, clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond')),
               revision = revision + 1
           WHERE repository_id = $1 AND target_ref = $2`,
          [request.repositoryId, request.targetRef, INTEGRATION_LEASE_GRACE_MS],
        );

        const existing = await connection.query<IntegrationRow>(
          `SELECT commit_sha
           FROM forge_repository_integrations
           WHERE repository_id = $1 AND target_ref = $2
             AND run_id = $3 AND task_id = $4 AND logical_attempt = $5
           FOR UPDATE`,
          [request.repositoryId, request.targetRef, request.runId, request.taskId, request.logicalAttempt],
        );
        const prior = existing.rows[0];
        if (prior) {
          return prior.commit_sha === request.commitSha
            ? { ok: true, commitSha: prior.commit_sha, reused: true }
            : { ok: false, code: "conflicting-integration" };
        }

        const repositoryRoot = await this.resolveRepositoryRoot(request.repositoryId);
        if (!repositoryRoot) throw new Error(`No writable repository is configured for repository ID ${request.repositoryId}`);
        const updated = await this.refUpdater.update(
          repositoryRoot,
          request.targetRef,
          request.commitSha,
          request.expectedHead,
        );
        if (!updated) return { ok: false, code: "expected-head-mismatch" };
        gitUpdated = true;

        await connection.query(
          `INSERT INTO forge_repository_integrations
            (schema_version, repository_id, target_ref, run_id, task_id, logical_attempt,
             operation_id, fencing_token, expected_head, commit_sha, integrated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
          [
            SCHEMA_VERSION,
            request.repositoryId,
            request.targetRef,
            request.runId,
            request.taskId,
            request.logicalAttempt,
            request.operationId,
            request.fencingToken,
            request.expectedHead,
            request.commitSha,
          ],
        );
        return { ok: true, commitSha: request.commitSha, reused: false };
      });
    } catch (error) {
      if (gitUpdated || error instanceof GitRefMutationAmbiguousError) {
        throw new RepositoryIntegrationAmbiguousError(request, error);
      }
      throw error;
    }
  }
}
