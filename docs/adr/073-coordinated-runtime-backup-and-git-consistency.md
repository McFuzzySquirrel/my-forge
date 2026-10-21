# ADR-073: Coordinated Runtime Backup and Git Consistency

**Status:** Accepted  
**Date:** 2026-10-21

## Context

P6-02 requires that backups coordinate the workflow database, application
receipts, Scheduler, artifacts, and Git refs. Restoring into a fresh
installation must keep pending timers, and missing or out-of-sync stores must
not silently accept incomplete tasks.

`runtime backup` already quiesced the stack and exported the PostgreSQL,
Scheduler, and runtime volumes with checksums. It did not cover two things:

1. **Git.** Target repositories are the operator's and may be large, shared, or
   backed up elsewhere, so the runtime does not copy them. But the stores record
   which commits each run integrated. A forge branch that moves after the backup
   puts Git and the restored stores out of sync:
   - *Git behind the stores:* accepted commits are missing. Later tasks
     integrated on the shorter branch, so a run could complete without the
     work it had already accepted.
   - *Git ahead of the stores:* the branch holds work the restored stores do
     not know about. The restored run repeats that work, which creates a
     second commit for the same task.
2. **Credentials.** Restored PostgreSQL data keeps the passwords it was
   initialized with. A fresh installation generates new ones, so the restore
   only failed later, at readiness.

## Decision

- **Record, don't copy, Git.** While quiesced, a backup records each registered
  repository's `refs/heads/forge/*` tips. Those are the only refs the service
  integrates into. It also records a SHA-256 fingerprint of the database
  credentials.
- **Verify before destroying.** `runtime restore` checks archive integrity, the
  credential fingerprint, and the recorded tips before it touches any volume.
  Damaged or incomplete archives, credentials that differ, unregistered
  repositories, and moved or missing forge branches are all refused. The
  refusal lists each drifted ref with the `git update-ref` command that resets
  it to the recorded commit. Backups that predate these fields are restored
  with a warning.
- **Explicit override.** `--allow-git-drift` restores anyway, for operators who
  reconcile Git themselves.
- **Fail closed at integration.** Under the fence lock, the integration
  authority checks that every commit the current run already integrated on
  the branch is still reachable. If one is missing, it abandons the intent with
  `integration-history-missing`. The execution host makes that failure
  non-retryable, so the run fails instead of building on lost history. The
  check covers only the current run's integrations, so a deliberate branch
  reset between runs does not block later runs.
- **Fresh-installation restore** is supported by copying `runtime.env` and
  re-registering repositories under the same IDs and paths. Credentials stay
  out of backups.

## Consequences

- Live qualification (`npm run -s qualify -- backup`) restores into a second
  installation with a pending 240 s retry timer and an approval wait. The timer
  fires at 240 s, and each task integrates exactly once. A run whose accepted
  commit was removed from Git fails with `integration-history-missing`. A
  branch that moved ahead is refused, and resetting it to the recorded tip
  re-runs the task exactly once.
- Forced drift (`--allow-git-drift`) with Git ahead of the stores can still
  integrate a task twice. The restore message states this.
- Backups require every registered repository to be readable. Remove stale
  registrations before backing up.
- Each integration adds one ancestry check of the run's latest earlier
  integration (which covers the earlier ones), under the fence lock.
