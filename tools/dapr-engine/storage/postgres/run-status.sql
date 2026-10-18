CREATE TABLE IF NOT EXISTS forge_run_statuses (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  run_id text PRIMARY KEY CHECK (length(run_id) > 0),
  repository_id text NOT NULL CHECK (length(repository_id) > 0),
  target_ref text NOT NULL CHECK (length(target_ref) > 0),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'pausing', 'paused', 'stopping', 'cancelling',
      'complete', 'failed', 'cancelled')
  ),
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS forge_run_tasks (
  run_id text NOT NULL REFERENCES forge_run_statuses(run_id),
  task_id text NOT NULL CHECK (length(task_id) > 0),
  task_index integer NOT NULL CHECK (task_index >= 0),
  status text NOT NULL CHECK (
    status IN ('pending', 'ready', 'running', 'waiting-for-approval',
      'complete', 'failed', 'skipped', 'cancelled')
  ),
  logical_attempt integer CHECK (logical_attempt IS NULL OR logical_attempt > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, task_id),
  UNIQUE (run_id, task_index)
);

CREATE TABLE IF NOT EXISTS forge_run_attempts (
  run_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  status text NOT NULL CHECK (
    status IN ('running', 'waiting-for-approval', 'complete', 'failed', 'skipped', 'cancelled')
  ),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, task_id, logical_attempt),
  FOREIGN KEY (run_id, task_id) REFERENCES forge_run_tasks(run_id, task_id)
);

CREATE TABLE IF NOT EXISTS forge_run_events (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  run_id text NOT NULL REFERENCES forge_run_statuses(run_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (event_type IN (
    'run.created', 'run.started', 'run.pausing', 'run.paused', 'run.stopping',
    'run.stopped', 'run.cancelling', 'run.cancelled', 'run.completed',
    'run.failed', 'run.reopened', 'run.resumed', 'attempt.started',
    'attempt.waiting-for-approval', 'attempt.resumed', 'attempt.failed',
    'task.completed', 'task.failed', 'task.skipped', 'task.cancelled',
    'task.replayed'
  )),
  task_id text,
  logical_attempt integer CHECK (logical_attempt IS NULL OR logical_attempt > 0),
  run_status text CHECK (
    run_status IS NULL OR run_status IN ('queued', 'running', 'pausing', 'paused',
      'stopping', 'cancelling', 'complete', 'failed', 'cancelled')
  ),
  task_status text CHECK (
    task_status IS NULL OR task_status IN ('pending', 'ready', 'running',
      'waiting-for-approval', 'complete', 'failed', 'skipped', 'cancelled')
  ),
  attempt_status text CHECK (
    attempt_status IS NULL OR attempt_status IN ('running', 'waiting-for-approval',
      'complete', 'failed', 'skipped', 'cancelled')
  ),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, event_key),
  FOREIGN KEY (run_id, task_id) REFERENCES forge_run_tasks(run_id, task_id),
  CHECK (run_status IS NOT NULL OR task_status IS NOT NULL OR attempt_status IS NOT NULL),
  CHECK ((task_id IS NOT NULL) OR (logical_attempt IS NULL AND task_status IS NULL AND attempt_status IS NULL)),
  CHECK (logical_attempt IS NOT NULL OR attempt_status IS NULL)
);

CREATE INDEX IF NOT EXISTS forge_run_events_task_idx
  ON forge_run_events (run_id, task_id, logical_attempt, sequence);
