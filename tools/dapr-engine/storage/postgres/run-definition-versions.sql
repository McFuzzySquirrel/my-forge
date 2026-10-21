-- P6-03: records which orchestration definition version owns each run so an
-- upgrade can refuse to start while unsupported in-flight runs remain.
ALTER TABLE forge_run_statuses
  ADD COLUMN IF NOT EXISTS definition_version integer NOT NULL DEFAULT 1
  CHECK (definition_version >= 1);
