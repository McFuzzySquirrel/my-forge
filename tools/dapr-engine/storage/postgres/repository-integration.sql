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
  integrated_at timestamptz NOT NULL,
  PRIMARY KEY (repository_id, target_ref, run_id, task_id, logical_attempt)
);
