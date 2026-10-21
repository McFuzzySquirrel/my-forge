# ADR-072: Runtime Failure Recovery and Live Qualification

**Status:** Accepted  
**Date:** 2026-10-21

## Context

P6-01 requires killing the application, sidecar, and worker during execution,
retry delays, and approval waits. It also requires store outages, duplicate
deliveries and controls, and late task results. Unit and PostgreSQL integration
tests already covered the deterministic boundaries (receipts, fencing,
checkpoints). A live run against the real Podman stack found five defects that
those tests could not see:

1. **Silent worker loss.** Dapr JS SDK 3.18 retries the workflow stream only
   when the first connection fails. If an established stream drops (for
   example, the sidecar restarts), the worker stops permanently. The service
   stayed "ready" but never ran workflow work again.
2. **Restart suppressed by dependencies.** Rootless Podman 4.9 (with
   podman-compose 1.0.6 `depends_on` → `--requires`) skips the `unless-stopped`
   restart when a required container is down at the moment the service exits.
3. **Unhandled store disconnects.** A PostgreSQL restart emitted an unhandled
   `pg` pool `error` event that crashed the service.
4. **Work after cancellation.** A cancel-stopped attempt was marked retryable,
   and the run workflow returned without stopping its child task workflows.
   A retry integrated a commit about a minute after `run.cancelled`. With
   retries removed, the late `task.failed` and the run's `task.cancelled` raced
   and the projection rejected `failed -> cancelled`, leaving the run stuck in
   `cancelling`.
5. **Orphaned run status.** Activities have no retry policy (SDK 3.18 offers
   none), so any activity error fails the run orchestration. A failed or
   terminated orchestration cannot record its own terminal status, so the run
   stayed non-terminal forever and kept its repository leases.

## Decision

- **Fail fast after dependencies return.** The service watches the SDK's
  worker state (`service/worker-watchdog.ts`). When the worker stops, the
  service waits up to 10 minutes for the Dapr sidecar and PostgreSQL to be
  reachable, then stops and exits non-zero. The container restart policy
  then starts a fresh worker. Exiting while a dependency is still down would
  suppress the restart (point 2).
- **Store errors are logged, not fatal.** The pool and each client have error
  listeners; queries in flight fail and the activity retry recovers them.
- **Cancellation is final for task work.** A cancel stop is non-retryable, and
  so is any failure recorded while the run is `cancelling` or `cancelled`. The
  execution host checks the run status before starting an attempt and before
  writing the integration `pending` journal. If the run is `cancelling` or
  `cancelled`, it returns the non-retryable `run-cancelled` outcome without
  touching the repository.
- **Cancellation wins the projection race.** A `task.cancelled` event may
  supersede a `failed` task. Any later task event for a task already cancelled
  in a cancelling or cancelled run is kept as an audit event but does not
  change the task status.
- **Failed orchestrations are reconciled.** At startup and every 60 s the
  service checks runs whose projected status is not terminal. If the run
  orchestration is `FAILED` or `TERMINATED`, it records `run.failed` (event key
  `run.orchestration-failed`, with the failure message truncated to 500
  characters) and releases the repository leases. Running, completed, and
  missing orchestrations are left alone; restart recovery reschedules missing
  ones.
- **Live qualification is a dev tool.** `tools/runtime-qualification` drives
  the launcher against an isolated Compose project selected with the new
  `MYFORGE_RUNTIME_PROJECT` and `MYFORGE_RUNTIME_DIR` overrides, so the
  operator's `myforge-runtime` installation is never touched.

## Consequences

- Recovery after a worker or sidecar loss depends on the restart policy and
  takes about 50–90 s. A dependency down for more than 10 minutes leaves the
  service running without a worker until it is restarted; the logs say so.
- A narrow window remains: an attempt that passed the cancel check can still
  integrate if cancellation arrives during integration. Validation commands
  are not under cancel supervision. Both are documented residual risks.
- The run workflow still does not terminate child workflows. Cancellation is
  enforced at the activity boundary instead, which avoids changing workflow
  yield order and keeps existing histories replayable.
- The qualification harness needs rootless Podman and the source launcher's
  dependencies. It is not part of `npm test`.
