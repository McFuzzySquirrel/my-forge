# ADR-079: Dapr Execution Cutover

**Status:** Accepted
**Date:** 2026-10-21
**Tags:** dapr, execution, migration, cutover

## Context

Phase 7 retires the legacy workflow scheduler after Linux rootless recovery,
security, upgrade, and release qualification. Before cutover, the launcher
selected the Dapr service only for registered repositories and otherwise
started the legacy in-process engine. Console controls also retained a
file/PID path for unregistered repositories.

Dapr workflow history and the legacy `WORKFLOW-STATE.json` format are not
compatible. A per-repository fallback after cutover would leave two schedulers
as supported authorities and make the retirement gate ineffective.

## Decision

- New launcher and Console execution/control requests require the local Dapr
  service. An unregistered repository fails closed with instructions to
  register it and restart the runtime.
- Do not import or translate legacy workflow histories. Preserve legacy state
  and artifacts as archival evidence; start a new Dapr run from the current
  repository revision.
- Treat rollback as an explicit writer-ownership change: stop Dapr writers
  before restoring a pre-cutover repository and state backup. Preserve
  post-cutover Git changes for reconciliation; never pass Dapr history to the
  legacy engine.
- Keep migration and rollback acceptance gated on rehearsals against
  disposable repositories. Runtime backups do not include target repositories
  or their working trees.

## Consequences

- A local runtime and repository registration are mandatory for supported
  builds and controls. Hosted execution remains unavailable.
- Unregistered repositories may continue authoring and manifest compilation,
  but cannot start, stop, pause, replay, or approve a build through the legacy
  scheduler.
- Legacy state is not deleted automatically. Operators must retain the
  repository backup, legacy artifacts, and any uncommitted work independently
  of service-volume backups.
- P7-04 retires the standalone scheduler, its visualization server, and legacy
  polling surfaces. The active Console Board remains supported as a
  Console-owned view and reads Dapr-backed run status.

## References

- [Phase 7 cutover tracker](../../plan.md#p7--cut-over-and-retire-the-legacy-scheduler)
- [Launcher cutover and rollback procedure](../forge-launcher.md#cut-over-from-the-legacy-engine)
- [Service execution entry points](071-service-harnesses-and-execution-entry-points.md)
- [Full replacement architecture](066-dapr-workflow-full-replacement-architecture.md)
