import { runCommand } from "../../execution/harness/run.ts";
import {
  gitIntegrationEffectDigest,
  SCHEMA_VERSION,
  type FencingLeaseV1,
  type Sha256Digest,
} from "../../contract/v1/index.ts";
import type { TaskCheckpointResult } from "../files/artifact-checkpoint-store.ts";
import type { SqlQueryable } from "./operation-receipts.ts";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const INTEGRATION_LEASE_GRACE_MS = GIT_TIMEOUT_MS + 5_000;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface TransactionalSqlConnection extends SqlQueryable {
  release(): void;
}

export interface TransactionalSqlDatabase {
  connect(): Promise<TransactionalSqlConnection>;
}

export type LeaseResult =
  | { readonly ok: true; readonly lease: FencingLeaseV1 }
  | { readonly ok: false; readonly code: "lease-held" };

/** Identifies one logical attempt's integration into a repository branch. */
export interface RepositoryIntegrationScope {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly runId: string;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
}

export interface RepositoryIntegrationRequest extends RepositoryIntegrationScope {
  readonly fencingToken: number;
  readonly expectedHead: string;
  readonly commitSha: string;
  /** Verified task checkpoint whose result tree the commit must carry. */
  readonly checkpointDigest: Sha256Digest;
}

export type IntegrationRecorder = "authority" | "reconciliation";

export type RepositoryIntegrationResult =
  | {
      readonly ok: true;
      readonly commitSha: string;
      readonly effectDigest: Sha256Digest;
      readonly reused: boolean;
      readonly recordedBy: IntegrationRecorder;
    }
  | {
      readonly ok: false;
      readonly code:
        | "no-lease"
        | "stale-fencing-token"
        | "expired-fencing-token"
        | "wrong-owner"
        | "conflicting-integration"
        | "expected-head-mismatch"
        | "checkpoint-unavailable"
        | "commit-checkpoint-mismatch"
        | "integration-abandoned";
    }
  | {
      readonly ok: false;
      /**
       * Another logical attempt's integration on this branch is still pending:
       * in flight, interrupted, or blocked by reconciliation. The branch cannot
       * advance until that attempt is reconciled.
       */
      readonly code: "unresolved-integration";
      readonly blockingAttempt: RepositoryIntegrationScope;
    };

export type IntegrationAbandonReason = "no-intent" | "commit-not-on-target" | "expected-head-mismatch";

export type RepositoryIntegrationReconciliation =
  | {
      readonly outcome: "integrated";
      readonly commitSha: string;
      readonly checkpointDigest: Sha256Digest;
      readonly effectDigest: Sha256Digest;
      readonly recordedBy: IntegrationRecorder;
      /** True when this call recorded a Git effect that lacked its durable integration record. */
      readonly backfilled: boolean;
    }
  | { readonly outcome: "not-integrated"; readonly reason: IntegrationAbandonReason }
  | {
      readonly outcome: "blocked";
      readonly reason:
        | "checkpoint-unavailable"
        | "commit-checkpoint-mismatch"
        | "conflicting-operation"
        | "commit-claimed-by-other-attempt";
    };

export interface GitRefUpdater {
  update(
    repositoryRoot: string,
    targetRef: string,
    newObject: string,
    expectedOldObject: string,
  ): Promise<boolean>;
}

export interface GitCommitIdentity {
  readonly tree: string;
  readonly parents: readonly string[];
}

/** Read-only Git queries the authority uses to bind and reconcile integrated commits. */
export interface GitIntegrationInspector {
  readCommit(repositoryRoot: string, commit: string): Promise<GitCommitIdentity | undefined>;
  /** Whether `commit` is reachable from the branch; false when either is absent. */
  contains(repositoryRoot: string, targetRef: string, commit: string): Promise<boolean>;
}

export type GitIntegrationRepository = GitRefUpdater & GitIntegrationInspector;

export interface CheckpointResolver {
  resolveCheckpoint(digest: Sha256Digest): Promise<TaskCheckpointResult>;
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
  run_id: string;
  task_id: string;
  logical_attempt: number;
  operation_id: string;
  expected_head: string;
  commit_sha: string;
  checkpoint_digest: string;
  recorded_by: IntegrationRecorder;
}

interface IntentRow extends Record<string, unknown> {
  operation_id: string;
  state: "pending" | "integrated" | "abandoned";
  fencing_token: string | number | null;
  expected_head: string | null;
  commit_sha: string | null;
  checkpoint_digest: string | null;
  abandon_reason: IntegrationAbandonReason | null;
}

interface EffectRow {
  readonly expected_head: string | null;
  readonly commit_sha: string | null;
  readonly checkpoint_digest: string | null;
}

const INTEGRATION_COLUMNS = `run_id, task_id, logical_attempt, operation_id, expected_head, commit_sha, checkpoint_digest, recorded_by`;
const INTENT_COLUMNS = `operation_id, state, fencing_token, expected_head, commit_sha, checkpoint_digest, abandon_reason`;
const ATTEMPT_PREDICATE = `repository_id = $1 AND target_ref = $2 AND run_id = $3 AND task_id = $4 AND logical_attempt = $5`;

type LeaseFailureCode = "no-lease" | "stale-fencing-token" | "expired-fencing-token" | "wrong-owner";

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

function validateRepositoryScope(repositoryId: string, targetRef: string): void {
  requireText(repositoryId, "Repository ID");
  requireText(targetRef, "Target ref");
  if (!targetRef.startsWith("refs/heads/") || targetRef === "refs/heads/") {
    throw new TypeError("Repository integration only supports fully qualified branch refs");
  }
}

function validateIntegrationScope(scope: RepositoryIntegrationScope): void {
  validateRepositoryScope(scope.repositoryId, scope.targetRef);
  requireText(scope.runId, "Run ID");
  requireText(scope.taskId, "Task ID");
  requireText(scope.operationId, "Operation ID");
  if (!Number.isSafeInteger(scope.logicalAttempt) || scope.logicalAttempt < 1) {
    throw new TypeError("Logical attempt must be a positive safe integer");
  }
}

function validateRequest(request: RepositoryIntegrationRequest): void {
  validateIntegrationScope(request);
  if (!Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1) {
    throw new TypeError("Repository fencing token must be a positive safe integer");
  }
  if (!GIT_OID_PATTERN.test(request.expectedHead)) {
    throw new TypeError("Expected repository head must be a full lowercase Git object ID");
  }
  if (!GIT_OID_PATTERN.test(request.commitSha)) {
    throw new TypeError("Integrated commit must be a full lowercase Git object ID");
  }
  if (request.expectedHead.length !== request.commitSha.length) {
    throw new TypeError("Expected head and integrated commit must use the same Git object format");
  }
  if (request.expectedHead === request.commitSha) {
    throw new TypeError("Integrated commit must differ from the expected head");
  }
  if (!SHA256_PATTERN.test(request.checkpointDigest)) {
    throw new TypeError("Checkpoint digest must be a sha256: digest");
  }
}

function attemptValues(scope: RepositoryIntegrationScope): unknown[] {
  return [scope.repositoryId, scope.targetRef, scope.runId, scope.taskId, scope.logicalAttempt];
}

function effectDigestOf(
  scope: RepositoryIntegrationScope,
  effect: { readonly expectedHead: string; readonly commitSha: string; readonly checkpointDigest: Sha256Digest },
): Sha256Digest {
  return gitIntegrationEffectDigest({
    repositoryId: scope.repositoryId,
    targetRef: scope.targetRef,
    runId: scope.runId,
    taskId: scope.taskId,
    logicalAttempt: scope.logicalAttempt,
    operationId: scope.operationId,
    expectedHead: effect.expectedHead,
    commitSha: effect.commitSha,
    checkpointDigest: effect.checkpointDigest,
  });
}

function sameEffect(row: EffectRow, request: RepositoryIntegrationRequest): boolean {
  return row.commit_sha === request.commitSha
    && row.checkpoint_digest === request.checkpointDigest
    && row.expected_head === request.expectedHead;
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

async function databaseNow(connection: SqlQueryable, purpose: string): Promise<number> {
  const result = await connection.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error(`Database did not return its current time for ${purpose}`);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error(`Database returned an invalid current time for ${purpose}`);
  return nowMs;
}

async function lockFence(connection: SqlQueryable, repositoryId: string, targetRef: string): Promise<FenceRow | undefined> {
  const locked = await connection.query<FenceRow>(
    `SELECT schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision
     FROM forge_repository_fences
     WHERE repository_id = $1 AND target_ref = $2
     FOR UPDATE`,
    [repositoryId, targetRef],
  );
  const fence = locked.rows[0];
  if (fence && fence.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported repository fence schema version: ${fence.schema_version}`);
  }
  return fence;
}

async function ensureAndLockFence(connection: SqlQueryable, repositoryId: string, targetRef: string): Promise<FenceRow> {
  await connection.query(
    `INSERT INTO forge_repository_fences
      (schema_version, repository_id, target_ref, fencing_token, owner_run_id, expires_at, revision)
     VALUES ($1, $2, $3, 0, NULL, NULL, 0)
     ON CONFLICT (repository_id, target_ref) DO NOTHING`,
    [SCHEMA_VERSION, repositoryId, targetRef],
  );
  const fence = await lockFence(connection, repositoryId, targetRef);
  if (!fence) throw new Error("Repository fence row was inserted but could not be locked");
  return fence;
}

/** Locks the scope's fence and checks the presented lease; the lock is held until the transaction ends. */
async function checkLease(connection: SqlQueryable, request: RepositoryIntegrationRequest): Promise<LeaseFailureCode | undefined> {
  const lease = await lockFence(connection, request.repositoryId, request.targetRef);
  if (!lease || !lease.owner_run_id || !lease.expires_at) return "no-lease";
  if (safeInteger(lease.fencing_token, "repository fencing token", 0) !== request.fencingToken) return "stale-fencing-token";
  if (lease.owner_run_id !== request.runId) return "wrong-owner";
  const nowMs = await databaseNow(connection, "repository integration");
  if (new Date(lease.expires_at).getTime() <= nowMs) return "expired-fencing-token";
  return undefined;
}

async function readIntegration(connection: SqlQueryable, scope: RepositoryIntegrationScope): Promise<IntegrationRow | undefined> {
  const result = await connection.query<IntegrationRow>(
    `SELECT ${INTEGRATION_COLUMNS} FROM forge_repository_integrations WHERE ${ATTEMPT_PREDICATE} FOR UPDATE`,
    attemptValues(scope),
  );
  return result.rows[0];
}

async function readIntent(connection: SqlQueryable, scope: RepositoryIntegrationScope): Promise<IntentRow | undefined> {
  const result = await connection.query<IntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM forge_repository_integration_intents WHERE ${ATTEMPT_PREDICATE} FOR UPDATE`,
    attemptValues(scope),
  );
  return result.rows[0];
}

/** A pending intent of a different logical attempt on the same branch, if any. */
async function otherPendingIntent(
  connection: SqlQueryable,
  scope: RepositoryIntegrationScope,
): Promise<RepositoryIntegrationScope | undefined> {
  const result = await connection.query<{ run_id: string; task_id: string; logical_attempt: number; operation_id: string }>(
    `SELECT run_id, task_id, logical_attempt, operation_id
     FROM forge_repository_integration_intents
     WHERE repository_id = $1 AND target_ref = $2 AND state = 'pending'
       AND NOT (run_id = $3 AND task_id = $4 AND logical_attempt = $5)
     ORDER BY created_at
     LIMIT 1`,
    attemptValues(scope),
  );
  const row = result.rows[0];
  return row && {
    repositoryId: scope.repositoryId,
    targetRef: scope.targetRef,
    runId: row.run_id,
    taskId: row.task_id,
    logicalAttempt: safeInteger(row.logical_attempt, "blocking logical attempt"),
    operationId: row.operation_id,
  };
}

async function commitClaimedByOtherAttempt(
  connection: SqlQueryable,
  scope: RepositoryIntegrationScope,
  commitSha: string,
): Promise<boolean> {
  const result = await connection.query<IntegrationRow>(
    `SELECT ${INTEGRATION_COLUMNS}
     FROM forge_repository_integrations
     WHERE repository_id = $1 AND target_ref = $2 AND commit_sha = $3`,
    [scope.repositoryId, scope.targetRef, commitSha],
  );
  return result.rows.some((row) =>
    row.run_id !== scope.runId || row.task_id !== scope.taskId || Number(row.logical_attempt) !== scope.logicalAttempt);
}

async function recordIntegration(
  connection: SqlQueryable,
  scope: RepositoryIntegrationScope,
  effect: { readonly fencingToken: number; readonly expectedHead: string; readonly commitSha: string; readonly checkpointDigest: string },
  recordedBy: IntegrationRecorder,
): Promise<void> {
  await connection.query(
    `INSERT INTO forge_repository_integrations
      (schema_version, repository_id, target_ref, run_id, task_id, logical_attempt,
       operation_id, fencing_token, expected_head, commit_sha, checkpoint_digest, recorded_by, integrated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())`,
    [
      SCHEMA_VERSION,
      ...attemptValues(scope),
      scope.operationId,
      effect.fencingToken,
      effect.expectedHead,
      effect.commitSha,
      effect.checkpointDigest,
      recordedBy,
    ],
  );
  await markIntentIntegrated(connection, scope);
}

async function markIntentIntegrated(connection: SqlQueryable, scope: RepositoryIntegrationScope): Promise<void> {
  await connection.query(
    `UPDATE forge_repository_integration_intents
     SET state = 'integrated', updated_at = clock_timestamp()
     WHERE ${ATTEMPT_PREDICATE} AND state = 'pending'`,
    attemptValues(scope),
  );
}

async function abandonIntent(
  connection: SqlQueryable,
  scope: RepositoryIntegrationScope,
  reason: IntegrationAbandonReason,
): Promise<void> {
  await connection.query(
    `UPDATE forge_repository_integration_intents
     SET state = 'abandoned', abandon_reason = $6, updated_at = clock_timestamp()
     WHERE ${ATTEMPT_PREDICATE} AND state = 'pending'`,
    [...attemptValues(scope), reason],
  );
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

async function resolveCommit(repositoryRoot: string, revision: string): Promise<string | undefined> {
  const result = await runGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (result.status === 1) return undefined;
  if (result.status !== 0) throw gitError("git rev-parse", result);
  return result.stdout.trim();
}

export class GitBranchRefUpdater implements GitIntegrationRepository {
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

    const current = await resolveCommit(repositoryRoot, targetRef);
    if (current !== expectedOldObject) return false;

    const update = await runGit(repositoryRoot, ["update-ref", "--no-deref", targetRef, newObject, expectedOldObject]);
    if (update.status === 0) return true;

    let currentAfterFailure: string | undefined;
    try {
      currentAfterFailure = await resolveCommit(repositoryRoot, targetRef);
    } catch (error) {
      throw new GitRefMutationAmbiguousError(targetRef, error);
    }
    if (currentAfterFailure === newObject) return true;
    if (currentAfterFailure !== expectedOldObject) return false;
    throw gitError("git update-ref", update);
  }

  async readCommit(repositoryRoot: string, commit: string): Promise<GitCommitIdentity | undefined> {
    if (await resolveCommit(repositoryRoot, commit) !== commit) return undefined;
    const shown = await runGit(repositoryRoot, ["show", "--no-patch", "--format=%T%x00%P", commit]);
    if (shown.status !== 0) throw gitError("git show", shown);
    const [tree, parents = ""] = shown.stdout.trim().split("\0");
    if (!tree || !GIT_OID_PATTERN.test(tree)) throw new Error(`git show returned an invalid tree for ${commit}`);
    return { tree, parents: parents.split(" ").filter(Boolean) };
  }

  async contains(repositoryRoot: string, targetRef: string, commit: string): Promise<boolean> {
    const validRef = await runGit(repositoryRoot, ["check-ref-format", targetRef]);
    if (validRef.status !== 0) throw gitError("git check-ref-format", validRef);
    const head = await resolveCommit(repositoryRoot, targetRef);
    if (!head) return false;
    if (await resolveCommit(repositoryRoot, commit) !== commit) return false;

    const ancestor = await runGit(repositoryRoot, ["merge-base", "--is-ancestor", commit, head]);
    if (ancestor.status === 0) return true;
    if (ancestor.status === 1) return false;
    throw gitError("git merge-base --is-ancestor", ancestor);
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
    private readonly checkpoints: CheckpointResolver,
    private readonly git: GitIntegrationRepository = new GitBranchRefUpdater(),
  ) {}

  async acquire(
    repositoryId: string,
    targetRef: string,
    runId: string,
    ttlMs: number,
  ): Promise<LeaseResult> {
    validateRepositoryScope(repositoryId, targetRef);
    requireText(runId, "Run ID");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError("Repository lease TTL must be a positive safe integer number of milliseconds");
    }

    return inTransaction(this.database, async (connection) => {
      const current = await ensureAndLockFence(connection, repositoryId, targetRef);
      const nowMs = await databaseNow(connection, "repository lease acquisition");
      const expiresAt = current.expires_at === null ? Number.NEGATIVE_INFINITY : new Date(current.expires_at).getTime();
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

  /**
   * Releases every lease a run still owns once it is terminal, so the next run
   * on the same target ref need not wait for the TTL. The fencing token is kept,
   * so tokens issued to the released run stay stale after a later acquire.
   */
  async releaseRun(runId: string): Promise<number> {
    requireText(runId, "Run ID");
    return inTransaction(this.database, async (connection) => {
      const released = await connection.query(
        `UPDATE forge_repository_fences
         SET owner_run_id = NULL, expires_at = NULL, revision = revision + 1
         WHERE owner_run_id = $1
         RETURNING repository_id`,
        [runId],
      );
      return released.rows.length;
    });
  }

  async integrate(request: RepositoryIntegrationRequest): Promise<RepositoryIntegrationResult> {
    validateRequest(request);
    const repositoryRoot = await this.repositoryRoot(request.repositoryId);
    const binding = await this.verifyBinding(repositoryRoot, request, request);
    if (binding) return { ok: false, code: binding };
    const effectDigest = effectDigestOf(request, request);

    // Phase 1: durably record the intended effect before any Git mutation.
    const prepared = await inTransaction(this.database, async (connection): Promise<RepositoryIntegrationResult | undefined> => {
      const leaseFailure = await checkLease(connection, request);
      if (leaseFailure) return { ok: false, code: leaseFailure };
      const prior = await readIntegration(connection, request);
      if (prior) return priorResult(prior, request, effectDigest);

      const intent = await readIntent(connection, request);
      if (intent?.state === "abandoned") return { ok: false, code: "integration-abandoned" };
      // Intents are created only here, under the fence lock, so at most one
      // attempt per branch can be pending; continuation waits for its resolution.
      const blockingAttempt = await otherPendingIntent(connection, request);
      if (blockingAttempt) return { ok: false, code: "unresolved-integration", blockingAttempt };
      if (intent) {
        return intent.operation_id === request.operationId && sameEffect(intent, request)
          ? undefined
          : { ok: false, code: "conflicting-integration" };
      }
      await connection.query(
        `INSERT INTO forge_repository_integration_intents
          (schema_version, repository_id, target_ref, run_id, task_id, logical_attempt, operation_id, state,
           fencing_token, expected_head, commit_sha, checkpoint_digest, abandon_reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, NULL, clock_timestamp(), clock_timestamp())`,
        [
          SCHEMA_VERSION,
          ...attemptValues(request),
          request.operationId,
          request.fencingToken,
          request.expectedHead,
          request.commitSha,
          request.checkpointDigest,
        ],
      );
      return undefined;
    });
    if (prepared) return prepared;

    // Phase 2: fenced mutation. The fence row lock is held through the Git
    // update and the integration record commit.
    let gitUpdated = false;
    try {
      return await inTransaction(this.database, async (connection): Promise<RepositoryIntegrationResult> => {
        const leaseFailure = await checkLease(connection, request);
        if (leaseFailure) return { ok: false, code: leaseFailure };

        await connection.query(
          `UPDATE forge_repository_fences
           SET expires_at = GREATEST(expires_at, clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond')),
               revision = revision + 1
           WHERE repository_id = $1 AND target_ref = $2`,
          [request.repositoryId, request.targetRef, INTEGRATION_LEASE_GRACE_MS],
        );

        const prior = await readIntegration(connection, request);
        if (prior) return priorResult(prior, request, effectDigest);
        const intent = await readIntent(connection, request);
        if (!intent) throw new Error("Repository integration intent disappeared before mutation");
        if (intent.state === "abandoned") return { ok: false, code: "integration-abandoned" };
        if (intent.state !== "pending" || intent.operation_id !== request.operationId || !sameEffect(intent, request)) {
          return { ok: false, code: "conflicting-integration" };
        }
        if (await commitClaimedByOtherAttempt(connection, request, request.commitSha)) {
          return { ok: false, code: "conflicting-integration" };
        }

        // A crash after an earlier ref update but before its record committed
        // leaves the commit on the branch; record it rather than reapplying it.
        if (await this.git.contains(repositoryRoot, request.targetRef, request.commitSha)) {
          await recordIntegration(connection, request, request, "reconciliation");
          return { ok: true, commitSha: request.commitSha, effectDigest, reused: true, recordedBy: "reconciliation" };
        }

        const updated = await this.git.update(
          repositoryRoot,
          request.targetRef,
          request.commitSha,
          request.expectedHead,
        );
        if (!updated) {
          await abandonIntent(connection, request, "expected-head-mismatch");
          return { ok: false, code: "expected-head-mismatch" };
        }
        gitUpdated = true;
        await recordIntegration(connection, request, request, "authority");
        return { ok: true, commitSha: request.commitSha, effectDigest, reused: false, recordedBy: "authority" };
      });
    } catch (error) {
      if (gitUpdated || error instanceof GitRefMutationAmbiguousError) {
        throw new RepositoryIntegrationAmbiguousError(request, error);
      }
      throw error;
    }
  }

  /**
   * Establishes whether a logical attempt's integration happened after a crash
   * or ambiguous result. A commit found on the branch without its record is
   * recorded for audit; an attempt whose commit is absent is abandoned so a late
   * integration with the same identity is rejected. Throws, leaving state
   * unchanged, when Git cannot be read.
   */
  async reconcile(scope: RepositoryIntegrationScope): Promise<RepositoryIntegrationReconciliation> {
    validateIntegrationScope(scope);
    return inTransaction(this.database, async (connection): Promise<RepositoryIntegrationReconciliation> => {
      await ensureAndLockFence(connection, scope.repositoryId, scope.targetRef);
      const record = await readIntegration(connection, scope);
      const intent = await readIntent(connection, scope);

      if (record) {
        if (record.operation_id !== scope.operationId) return { outcome: "blocked", reason: "conflicting-operation" };
        if (intent?.state === "pending") await markIntentIntegrated(connection, scope);
        return this.integratedOutcome(scope, record, record.recorded_by, false);
      }

      if (!intent) {
        await connection.query(
          `INSERT INTO forge_repository_integration_intents
            (schema_version, repository_id, target_ref, run_id, task_id, logical_attempt, operation_id, state,
             fencing_token, expected_head, commit_sha, checkpoint_digest, abandon_reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'abandoned', NULL, NULL, NULL, NULL, 'no-intent',
                   clock_timestamp(), clock_timestamp())`,
          [SCHEMA_VERSION, ...attemptValues(scope), scope.operationId],
        );
        return { outcome: "not-integrated", reason: "no-intent" };
      }
      if (intent.operation_id !== scope.operationId) return { outcome: "blocked", reason: "conflicting-operation" };
      if (intent.state === "abandoned") {
        if (!intent.abandon_reason) throw new Error("Database returned an abandoned integration intent without a reason");
        return { outcome: "not-integrated", reason: intent.abandon_reason };
      }
      if (
        intent.state !== "pending" || intent.fencing_token === null
        || !intent.commit_sha || !intent.expected_head || !intent.checkpoint_digest
      ) {
        throw new Error("Repository integration intent is inconsistent with its integration record");
      }

      const repositoryRoot = await this.repositoryRoot(scope.repositoryId);
      if (await commitClaimedByOtherAttempt(connection, scope, intent.commit_sha)) {
        return { outcome: "blocked", reason: "commit-claimed-by-other-attempt" };
      }
      if (!await this.git.contains(repositoryRoot, scope.targetRef, intent.commit_sha)) {
        await abandonIntent(connection, scope, "commit-not-on-target");
        return { outcome: "not-integrated", reason: "commit-not-on-target" };
      }

      const effect = {
        fencingToken: safeInteger(intent.fencing_token, "integration intent fencing token"),
        expectedHead: intent.expected_head,
        commitSha: intent.commit_sha,
        checkpointDigest: intent.checkpoint_digest as Sha256Digest,
      };
      // An unverifiable effect stays pending (its intent keeps the audit
      // trail), so the branch remains blocked until the binding can be proven.
      const binding = await this.verifyBinding(repositoryRoot, scope, effect);
      if (binding) return { outcome: "blocked", reason: binding };
      await recordIntegration(connection, scope, effect, "reconciliation");
      return {
        outcome: "integrated",
        commitSha: effect.commitSha,
        checkpointDigest: effect.checkpointDigest,
        effectDigest: effectDigestOf(scope, effect),
        recordedBy: "reconciliation",
        backfilled: true,
      };
    });
  }

  private async integratedOutcome(
    scope: RepositoryIntegrationScope,
    row: { readonly expected_head: string; readonly commit_sha: string; readonly checkpoint_digest: string },
    recordedBy: IntegrationRecorder,
    backfilled: boolean,
  ): Promise<RepositoryIntegrationReconciliation> {
    const effect = {
      expectedHead: row.expected_head,
      commitSha: row.commit_sha,
      checkpointDigest: row.checkpoint_digest as Sha256Digest,
    };
    const repositoryRoot = await this.repositoryRoot(scope.repositoryId);
    const binding = await this.verifyBinding(repositoryRoot, scope, effect);
    if (binding) return { outcome: "blocked", reason: binding };
    return {
      outcome: "integrated",
      commitSha: effect.commitSha,
      checkpointDigest: effect.checkpointDigest,
      effectDigest: effectDigestOf(scope, effect),
      recordedBy,
      backfilled,
    };
  }

  private async repositoryRoot(repositoryId: string): Promise<string> {
    const root = await this.resolveRepositoryRoot(repositoryId);
    if (!root) throw new Error(`No writable repository is configured for repository ID ${repositoryId}`);
    return root;
  }

  /** The commit must sit directly on the expected head and carry the verified checkpoint's result tree. */
  private async verifyBinding(
    repositoryRoot: string,
    scope: RepositoryIntegrationScope,
    effect: { readonly expectedHead: string; readonly commitSha: string; readonly checkpointDigest: Sha256Digest },
  ): Promise<"checkpoint-unavailable" | "commit-checkpoint-mismatch" | undefined> {
    const checkpoint = await this.checkpoints.resolveCheckpoint(effect.checkpointDigest);
    if (!checkpoint.ok) return "checkpoint-unavailable";
    if (checkpoint.checkpoint.runId !== scope.runId) return "commit-checkpoint-mismatch";
    const commit = await this.git.readCommit(repositoryRoot, effect.commitSha);
    if (!commit || commit.parents[0] !== effect.expectedHead || commit.tree !== checkpoint.checkpoint.gitTreeId) {
      return "commit-checkpoint-mismatch";
    }
    return undefined;
  }
}

function priorResult(
  prior: IntegrationRow,
  request: RepositoryIntegrationRequest,
  effectDigest: Sha256Digest,
): RepositoryIntegrationResult {
  return sameEffect(prior, request)
    ? { ok: true, commitSha: prior.commit_sha, effectDigest, reused: true, recordedBy: prior.recorded_by }
    : { ok: false, code: "conflicting-integration" };
}
