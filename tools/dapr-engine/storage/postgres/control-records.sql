CREATE TABLE IF NOT EXISTS forge_control_records (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  control_id uuid PRIMARY KEY,
  run_id text NOT NULL CHECK (length(run_id) > 0),
  action text NOT NULL CHECK (
    action IN ('select-tasks', 'pause', 'resume', 'stop', 'cancel', 'replay-task', 'approve-task')
  ),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  requested_by text CHECK (requested_by IS NULL OR length(requested_by) > 0),
  state text NOT NULL CHECK (state IN ('requested', 'accepted', 'applied', 'rejected')),
  history jsonb NOT NULL CHECK (
    jsonb_typeof(history) = 'array' AND jsonb_array_length(history) > 0
  ),
  reason_code text CHECK (
    reason_code IS NULL OR reason_code IN (
      'unsupported-schema-version', 'unknown-run', 'unknown-control', 'control-conflict',
      'invalid-run-state', 'invalid-task-state', 'unknown-task',
      'selection-immutable', 'operator-identity-required', 'stale-evidence'
    )
  ),
  approval_binding jsonb CHECK (
    approval_binding IS NULL OR jsonb_typeof(approval_binding) = 'object'
  ),
  record_version bigint NOT NULL CHECK (record_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'rejected') = (reason_code IS NOT NULL)),
  CHECK (
    approval_binding IS NULL OR COALESCE((
      action = 'approve-task' AND state IN ('accepted', 'applied')
      AND jsonb_typeof(approval_binding->'runId') = 'string'
      AND approval_binding->>'runId' = run_id
      AND jsonb_typeof(approval_binding->'taskId') = 'string'
      AND approval_binding->>'taskId' = payload->>'taskId'
      AND jsonb_typeof(approval_binding->'operatorId') = 'string'
      AND approval_binding->>'operatorId' = requested_by
      AND jsonb_typeof(approval_binding->'manifestDigest') = 'string'
      AND approval_binding->>'manifestDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(approval_binding->'logicalAttempt') = 'number'
      AND approval_binding->>'logicalAttempt' ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(approval_binding->'taskWorkflowInstanceId') = 'string'
      AND length(approval_binding->>'taskWorkflowInstanceId') > 0
      AND jsonb_typeof(approval_binding->'evidenceDigests') = 'array'
    ), FALSE)
  ),
  CHECK (
    action <> 'approve-task' OR state NOT IN ('accepted', 'applied')
    OR approval_binding IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS forge_control_records_run_idx
  ON forge_control_records (run_id, created_at, control_id);

CREATE INDEX IF NOT EXISTS forge_control_records_approval_idx
  ON forge_control_records (run_id, updated_at DESC)
  WHERE action = 'approve-task' AND state = 'applied';
