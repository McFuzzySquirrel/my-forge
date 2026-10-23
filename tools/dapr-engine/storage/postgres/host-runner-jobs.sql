CREATE TABLE forge_host_runner_jobs (
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  operation_id uuid PRIMARY KEY,
  run_id text NOT NULL CHECK (run_id ~ '^run_[0-9a-f]{32}$'),
  task_id text NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  repository_id text NOT NULL CHECK (repository_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
  lease_id uuid,
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  result jsonb,
  error_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (state = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((state = 'completed') = (result IS NOT NULL)),
  CHECK ((state = 'failed') = (error_message IS NOT NULL))
);

CREATE INDEX forge_host_runner_jobs_queue_idx
  ON forge_host_runner_jobs (repository_id, created_at)
  WHERE state = 'queued';

CREATE INDEX forge_host_runner_jobs_lease_idx
  ON forge_host_runner_jobs (lease_expires_at)
  WHERE state = 'leased';
