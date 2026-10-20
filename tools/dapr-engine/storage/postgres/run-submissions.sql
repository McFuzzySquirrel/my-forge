-- Accepted run submissions owned by the local execution service (P5-03). The
-- immutable snapshot is the only input the service needs to rebind a run after
-- a restart; a reused submission key with a different snapshot is a conflict.
CREATE TABLE IF NOT EXISTS forge_run_submissions (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  submission_key text PRIMARY KEY CHECK (char_length(submission_key) BETWEEN 1 AND 256),
  run_id text NOT NULL UNIQUE CHECK (run_id ~ '^run_[0-9a-f]{32}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  submission jsonb NOT NULL CHECK (jsonb_typeof(submission) = 'object'),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS forge_run_submissions_created_idx
  ON forge_run_submissions (created_at DESC, run_id);

-- Replay-task controls allocate exactly one fresh logical attempt per control,
-- so re-applying an already-applied control returns the same attempt.
CREATE TABLE IF NOT EXISTS forge_replay_allocations (
  control_id uuid PRIMARY KEY,
  run_id text NOT NULL REFERENCES forge_run_submissions(run_id),
  task_id text NOT NULL CHECK (length(task_id) > 0),
  logical_attempt integer NOT NULL CHECK (logical_attempt > 1),
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, task_id, logical_attempt)
);
