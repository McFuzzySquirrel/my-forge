# ADR-088: Remove the pre-Dapr legacy engine

## Status

Accepted.

## Context

The in-process `forge-workflow-engine` scheduler is retired. New execution is
owned by the Dapr-backed local service; host execution and the worker container
both write to the same completion ledger. The launcher and Console still
carried read-only legacy-state handling, the retired skill package, and a
compatibility `engine-run` command name. Those paths add support surface without
serving current runs.

## Decision

- Remove the retired `forge-workflow-engine` skill package and bootstrap staging.
- Remove legacy file/PID state handling for `WORKFLOW-STATE.json`,
  `engine-control.json`, and `engine.pid`. Existing files are left untouched but
  are not read, resumed, or controlled.
- Remove the `engine-run` CLI. Its service-backed behavior is exposed as
  `forge-launcher run`. Authoring and manifest commands are unchanged:
  interactive requirements sessions, `draft-team`, `draft-skills`, `rederive`,
  `feature-increment-continue`, `resume`, and execution-adapter compilation do
  not depend on `engine-run`.
- Rename the repository activity log from `docs/engine-run.log` to
  `docs/forge.log`. The old path remains readable for existing repositories but
  receives no new writes. The Console tab is renamed **Activity log**.
- Delete the historical workflow-engine overview/deep-dive, legacy artifact-store
  deep dive, and historical board/rederive plan. ADRs and changelog entries remain
  as historical records.

## Consequences

- Pre-Dapr repositories are not imported or run by this launcher. Their own
  repository files are not deleted.
- There is one autonomous entry point, `forge-launcher run`, plus
  `forge-launcher service submit` for automation.
- Authoring and manifest workflows keep their existing commands and interactive
  handoffs.
