CREATE INDEX forge_host_runner_jobs_active_summary_idx
  ON forge_host_runner_jobs (updated_at DESC, operation_id DESC)
  WHERE state IN ('queued', 'leased');

CREATE INDEX forge_host_runner_jobs_terminal_summary_idx
  ON forge_host_runner_jobs (updated_at DESC, operation_id DESC)
  WHERE state IN ('completed', 'failed', 'cancelled');
