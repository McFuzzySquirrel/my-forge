# ADR-090: Phase-gated runs and the temporary host-runner default

## Status

Accepted.

## Context

Long projects should not be one monolithic run. The execution manifest already
groups tasks into dependency-aware phases, but run selection is task-based. An
operator can select a phase's tasks manually, yet there is no phase selector,
no persisted phase scope, and no "next phase" workflow in the Console.

The current local profile also defaults to the worker container. While the
worker is the more reproducible and sandboxed executor, operators working on
long local projects need the CLI installed on their own machine. The host runner
is already implemented and explicit; the requested temporary policy is to make
it the default for local runs until the worker path is the better daily choice.

Host execution is unsandboxed and uses the operator's full OS permissions. That
trade-off must remain visible.

## Decision

- Add `--phase <id,id,...>` (`--phases` alias) to launcher/service submission.
  Resolve phase IDs to their task IDs before the existing manual-selection path
  submits the run.
- Keep prerequisite expansion in the service: a phase run includes earlier
  phases through the normal task/phase dependency graph. Completed prerequisite
  tasks replay from the completion ledger rather than re-running the harness.
- Add a persisted `phase` selection scope and Console **Select phase**,
  **Run phase**, and **Run next phase** actions.
- Do not add a phase-level commit. Each task's integrated commit is already on
  `forge/<branch>`; the phase's code tip is the last such commit. Advancing the
  checked-out branch or remote remains an explicit `service merge`/`git push`.
- Add an explicit `executor` setting to `docs/engine-config.json`. An absent
  value means **host** for the temporary default; only an explicit `"worker"`
  opts into the container. Retain the older `hostExecution` field for
  compatibility.
- Make the launcher, `service submit`, and Console default to host execution.
  Add `--worker-execution` as the explicit opt-out. Host execution still never
  falls back to the worker.
- Keep the host-execution warning and readiness gate. The default changes
  convenience, not the security boundary.

## Consequences

- Operators can run one phase at a time and review before starting the next.
- Phase runs still contain prerequisite tasks, so a large accumulated project
  can hit the 1,000-task run limit. Fully phase-isolated runs need
  service-authoritative satisfied-prerequisite state and are deferred.
- Existing `hostExecution: false` values without an explicit `executor` are
  treated as host under the temporary policy. Users who want the worker must
  save Worker in the Console or pass `--worker-execution` / use the explicit
  `executor: "worker"` setting.
- The Console and CLI continue to disclose that host execution is unsandboxed.
- Phase completion is an operational boundary backed by task evidence, not a
  new Git commit or orchestration primitive.
