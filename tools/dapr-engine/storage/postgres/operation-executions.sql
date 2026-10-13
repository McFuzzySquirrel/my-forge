-- Execution ownership for harness processes (contract v1 §3 "Process lifecycle
-- and isolation"). Apply after operation-receipts.sql: each row belongs to an
-- operation receipt. A larger execution_epoch fences every earlier owner.
CREATE TABLE IF NOT EXISTS forge_operation_executions (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  run_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  operation_id text NOT NULL,
  execution_epoch bigint NOT NULL CHECK (execution_epoch > 0),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 512),
  state text NOT NULL CHECK (state IN ('running', 'cancel-requested', 'exited', 'published', 'lost')),
  deadline_at timestamptz NOT NULL,
  heartbeat_expires_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 512),
  exit_record jsonb CHECK (exit_record IS NULL OR jsonb_typeof(exit_record) = 'object'),
  lost_epochs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(lost_epochs) = 'array' AND jsonb_array_length(lost_epochs) <= 32
  ),
  CHECK ((state IN ('exited', 'published')) = (exit_record IS NOT NULL)),
  CHECK (state <> 'cancel-requested' OR cancel_reason IS NOT NULL),
  PRIMARY KEY (run_id, task_id, logical_attempt, operation_id),
  FOREIGN KEY (run_id, task_id, logical_attempt, operation_id)
    REFERENCES forge_operation_receipts (run_id, task_id, logical_attempt, operation_id)
);

CREATE INDEX IF NOT EXISTS forge_operation_executions_heartbeat_idx
  ON forge_operation_executions (heartbeat_expires_at)
  WHERE state IN ('running', 'cancel-requested');
