CREATE TABLE IF NOT EXISTS forge_repository_fences (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  repository_id text NOT NULL,
  target_ref text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
  owner_run_id text,
  expires_at timestamptz,
  revision bigint NOT NULL CHECK (revision >= 0),
  CHECK ((owner_run_id IS NULL) = (expires_at IS NULL)),
  PRIMARY KEY (repository_id, target_ref)
);

-- Durable record of what a logical attempt will integrate, committed before
-- the Git ref mutation so crash reconciliation can establish the outcome.
-- An `abandoned` row without a commit is a tombstone written by reconciliation
-- for an attempt that never recorded an intent; it fences late integration.
CREATE TABLE IF NOT EXISTS forge_repository_integration_intents (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  repository_id text NOT NULL,
  target_ref text NOT NULL,
  run_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  operation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'integrated', 'abandoned')),
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  expected_head text CHECK (expected_head IS NULL OR expected_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  checkpoint_digest text CHECK (checkpoint_digest IS NULL OR checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'),
  abandon_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (fencing_token IS NULL) = (commit_sha IS NULL)
    AND (expected_head IS NULL) = (commit_sha IS NULL)
    AND (checkpoint_digest IS NULL) = (commit_sha IS NULL)
  ),
  CHECK (state = 'abandoned' OR commit_sha IS NOT NULL),
  CHECK ((state = 'abandoned') = (abandon_reason IS NOT NULL)),
  PRIMARY KEY (repository_id, target_ref, run_id, task_id, logical_attempt)
);

-- Unresolved (pending) integrations block their branch; integrate() looks them up.
CREATE INDEX IF NOT EXISTS forge_repository_integration_intents_pending
  ON forge_repository_integration_intents (repository_id, target_ref, created_at)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS forge_repository_integrations (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  repository_id text NOT NULL,
  target_ref text NOT NULL,
  run_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  operation_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expected_head text NOT NULL CHECK (expected_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  checkpoint_digest text NOT NULL CHECK (checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_by text NOT NULL CHECK (recorded_by IN ('authority', 'reconciliation')),
  integrated_at timestamptz NOT NULL,
  PRIMARY KEY (repository_id, target_ref, run_id, task_id, logical_attempt),
  UNIQUE (repository_id, target_ref, commit_sha)
);
