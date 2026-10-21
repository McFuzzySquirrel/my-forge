# ADR-074: Workflow Definition Versioning and Upgrade Qualification

**Status:** Accepted  
**Date:** 2026-10-21

## Context

P6-03 requires versioned workflow definitions and activity contracts, a plan for
runs that an upgrade cannot continue, and proof of historical replay, schema
upgrades, and the documented rollback limits.

Dapr Workflow continues a run by replaying its recorded history through the
workflow code. If a release changes the order or names of the activities,
timers, child workflows, or external events a workflow waits for, replay raises
a non-determinism error and the in-flight run stops. Before P6-03:

- Workflow names (`runOrchestrationWorkflow`, `taskAttemptWorkflow`) were
  unversioned, and runs did not record which definition started them.
- Payloads carried `schemaVersion: 1`, and the application database refused a
  schema newer than the code (`Database schema version N is newer …`). However,
  no test replayed recorded histories against changed code.
- Nobody had tried an upgrade with work in flight, or a rollback, against a
  live stack.

## Decision

1. **Definition version on each run.** `orchestration/versioning.ts` defines
   `ORCHESTRATION_DEFINITION_VERSION` (currently 1) and the set of versions this
   build can replay. Migration 7 (`run-definition-versions.sql`) adds
   `forge_run_statuses.definition_version`. Existing rows get 1, and new runs
   are stamped at registration.
2. **Startup gate.** After migrations, the service refuses to start when a
   non-terminal run uses a definition version this build does not support. The
   message names the count and version, and says to finish or cancel those runs
   with the release that started them, or to roll back to it.
3. **Compatibility rule.**
   - A compatible change keeps the version. A change is compatible if recorded
     histories still replay.
   - An incompatible change registers its workflows under new names and bumps
     the version. It keeps the earlier definitions registered, with their
     version still supported, until runs that use them have drained.
   - Activity inputs and outputs keep their `schemaVersion` and stay
     backward-readable within a definition version.
4. **Historical replay tests.** The harness command
   `capture-histories <project> <dir>` exports terminal histories from an
   isolated installation's Dapr state store. It keeps one per distinct
   feature set: timers, external task and run controls, activity failures,
   and completion status.
   - It skips histories whose action event IDs are not contiguous. A restore
     with `--allow-git-drift` can leave such histories behind.
   - `tests/orchestration/history-replay.test.ts` replays the committed
     fixtures through the SDK's `OrchestrationExecutor` with the current
     workflows. Each replay must reach the recorded completion status and
     result.
   - A negative control inserts one activity at the start of the workflow and
     must fail replay with `NonDeterminismError`.
5. **Live upgrade and rollback suite.** The harness `upgrade` suite runs the
   previous release from a git worktree. That release's engine is mounted next
   to its launcher.
   - **U01:** with an approval wait and a pending retry timer in flight, upgrade
     in place. Migration 7 applies, and both runs complete with exactly one
     commit per task. A new run is stamped with the current definition version.
   - **U02:** after an upgrade, the previous release refuses the migrated
     schema. Restoring the pre-upgrade backup with the previous release
     resumes the approval wait, and the run completes exactly once.
6. **Rollback limit.** The schema is never migrated back. To return to an
   earlier release, restore a backup taken with that release before the upgrade.
   Work done after that backup is lost: the drift checks in ADR-073 refuse the
   restore if Git moved since then, unless the operator allows it explicitly.

## Consequences

- Upgrades that keep recorded histories replayable need no draining. The replay
  test catches regressions in CI before a release.
- Refresh the fixtures after a deliberate compatible change that adds new
  history shapes, using `capture-histories` against a qualified stack.
- A release with an incompatible change must keep the previous definitions
  registered, or operators must drain first. The startup gate prevents a silent
  stall.
- The upgrade suite is pinned to the commit of the previous release. Move the
  pin forward with each release.
