CREATE TABLE IF NOT EXISTS forge_operation_receipts (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  run_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  operation_id text NOT NULL,
  state text NOT NULL CHECK (
    state IN ('claimed', 'executing', 'effect-published', 'accepted', 'failed', 'ambiguous')
  ),
  record_version bigint NOT NULL CHECK (record_version > 0),
  effect_digest text CHECK (effect_digest IS NULL OR effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  diagnostic_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(diagnostic_refs) = 'array'
    AND jsonb_array_length(diagnostic_refs) <= 32
  ),
  PRIMARY KEY (run_id, task_id, logical_attempt, operation_id)
);

CREATE INDEX IF NOT EXISTS forge_operation_receipts_reconciliation_idx
  ON forge_operation_receipts (updated_at, run_id, task_id, logical_attempt, operation_id)
  WHERE state IN ('claimed', 'executing', 'effect-published', 'ambiguous');
