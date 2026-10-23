---
id: ADR-082
type: adr
title: Per-run executor selection with readiness gating in the Console
status: accepted
derived_from:
  - SDR-20261023-001
date: '2026-10-23'
---

# ADR-082: Per-run executor selection with readiness gating in the Console

## Context

[ADR-081](081-native-local-harness-execution-without-task-sandbox.md) made
native host execution an explicit alternative to the default worker-container
runner. The Console exposed that choice as a project-level checkbox that wrote
`hostExecution` to `docs/engine-config.json` and was read again when a run
started. Three problems followed:

- The control sat beside **Run**/Resume but described a saved default, so a
  change appeared to affect the run the operator was about to start.
- The selection was persisted implicitly, so a single experimental host run
  became the project default for later runs.
- The Console accepted the change without checking runner readiness and learned
  about a stopped runner or revoked capability only when submission failed with
  `harness-unavailable`.

At the same time, `service submit` never read `engine-config.json` — not even
for the harness — while Console-spawned `engine-run` honoured the saved host
value. Making the CLI read the same file would have let a saved GUI preference
change whether a script ran a harness with the operator's full OS permissions,
which conflicts with the "never silently switch execution mode" requirement.

## Decision

- Treat the executor as a **per-run choice**. The Console sends `worker` or
  `host` with the run request and translates it to the presence or absence of
  `--host-execution`; it never infers the executor from a file for a run it
  starts.
- Keep `docs/engine-config.json` `hostExecution` as the **pre-selection only**.
  Persisting a new default is a separate, explicit **Save as default for this
  project** action that keeps the existing confirmation requirement.
- Gate an explicit host request in the Console server before submission. The
  check requires repository registration, an enabled project capability, and a
  running host runner, and returns `409 host-runner-unavailable` with the
  missing prerequisite. The service remains authoritative and still fails
  closed with `harness-unavailable`.
- Keep CLI submission commands explicit-only. Neither `engine-run` nor
  `service submit` reads the saved `hostExecution` value, so a saved Console
  preference cannot change what a script runs.
- Expose readiness through a narrow endpoint that reads the repository registry,
  capabilities, and runner process — not the container inventory — so the
  Overview can poll it without spawning Podman.
- Name the active run's executor in Overview and mark that executor changes
  apply to the next run, because the runner binds at submission.

## Consequences

- Operators choose an executor at the point of action, and an experimental host
  run does not silently become the project default.
- The Console and CLI now agree on default behaviour: both run in the worker
  unless a host run is requested for that invocation.
- Runner readiness failures are surfaced before a submission is created, with a
  link to the fix, rather than as a late service rejection.
- The gating check duplicates part of the service's rule. It is a preflight
  only; a readiness change between the check and submission still fails closed
  in the service.
- A Console client that predates the selector omits the field and keeps the
  previous config-driven behaviour until it is refreshed.

## Alternatives considered

- **Persist on change:** fewer clicks, but re-creates the silent default change
  this decision removes.
- **Make the CLI read the saved default:** consistent across entry points, but
  lets a GUI preference elevate a script to unsandboxed host execution. A
  guarded variant that requires an interactive terminal was deferred rather than
  bundled with a UI change.
- **Leave the project-level checkbox:** smallest change, but keeps the
  readiness, persistence, and active-run ambiguities.

## References

- [Forge Console](../forge-console.md#executor)
- [Console user guide](../forge-console-user-guide.md#manage-local-execution)
- [Local execution architecture](../local-execution.md#worker-mode-and-host-mode)
- [Local host harness execution contract](../features/local-host-harness-execution.md)
- [ADR-081: Native local harness execution without task sandbox](081-native-local-harness-execution-without-task-sandbox.md)
