# Long-running projects

This page explains how MyForge behaves for projects that run for days or weeks,
how phase-by-phase execution works, and where the current local runtime stops
being the right operating model.

## Short answer

The Dapr-backed runtime is **better for long-lived projects** than the pre-Dapr
file-based engine. Durable workflow state, bounded history, restart recovery,
checkpoint evidence, completion replay, and safer Git integration matter much
more over weeks than over a single short run.

It is **not** a set-and-forget high-availability service. The current local
profile is a durable single-host runtime. A multi-week project should be
operated as a series of bounded runs, normally one phase or milestone at a time.
For unattended cross-host operation, the shared/hosted P8 profile is the
intended answer.

## Pre-Dapr and current architecture

The pre-Dapr engine was not primitive. It already supported resumable local
runs, retries, approvals, parallel worktrees, typed artifacts, and verification
gates. Its weaknesses became important as runs grew longer and more autonomous:

| Area | Pre-Dapr | Current |
|---|---|---|
| Orchestration authority | File state plus a local process; the Console could also mutate state | One Dapr workflow authority with persisted controls and receipts |
| Crash/restart recovery | Reconstruct files, process state, and local artifacts | Durable workflow history, timers, approvals, and controls; bounded history rollover |
| Git integration | Local engine writes commits | Expected-head checks, leases, fencing, `forge/*` integration, rebase/retry, never advances the checked-out branch |
| Cross-run continuity | Task state is scoped to a run/local state | Completion ledger, replay of integrated tasks, checkpoint bundles |
| Evidence | Repository-local artifacts and audit files | Content-addressed work, validation and Git-bundle artifacts; Evidence API/view |
| Isolation | Host process with the operator's permissions | Worker container with per-task UIDs and scoped credentials; host execution is visible, temporary-default, and unsandboxed |
| Multiple projects | One local scheduler per project | Multiple registered repositories and concurrent runs share one runtime |
| Operational weight | Low | Podman, PostgreSQL, Dapr, migrations, volumes, tokens, backups |
| Hosted/shared future | Not designed as a service | P8 direction: shared persistence, authentication, clean-host recovery |

The trade is deliberate: **more infrastructure and complexity in exchange for
stronger durability, isolation, auditability, and recovery**. A single user who
only wants a lightweight local task runner may prefer the old model's
simplicity; that does not make it the better fit for autonomous, multi-week
repository work.

## Limits that matter for long runs

These limits are enforced by the execution contract:

| Limit | Ceiling |
|---|---|
| Task attempt timeout | 24 hours |
| Retries per logical task | 10 |
| Retry delay | 24 hours |
| Selected tasks per run | 1,000 |
| Concurrency per run | 8 active task attempts |
| Approval waits per task attempt | 16 |
| Workflow history | Bounded by rollover, default 64 history units |
| Work/validation artifact | 32 MiB |
| Checkpoint Git bundle | 512 MiB |

A single task running for weeks is not supported. A project running for weeks
is supported by using many bounded tasks and multiple runs.

## Recommended operating model

1. **Split by phase or milestone.** Do not put an entire multi-week project into
   one run.
2. **Use completion replay.** Finished tasks replay from the completion ledger
   without another model call.
3. **Keep tasks short.** Prefer minutes or hours; leave the 24-hour ceiling for
   exceptional work.
4. **Preserve the forge branch.** Push `forge/*` and take runtime backups at
   phase boundaries.
5. **Pin versions.** Do not upgrade the launcher/runtime/database in the middle
   of a critical run.
6. **Recheck credentials.** Harness grants, provider tokens, and GitHub access
   can expire while a run waits.
7. **Monitor storage.** Artifact and checkpoint retention/GC are not automated
   in the local profile.
8. **Keep the runtime running.** Durable state survives a stop/restart, but no
   work progresses while the runtime is stopped.
9. **Choose the executor deliberately.** Native host execution is the temporary
   default and uses the local CLI with full OS permissions. Select the worker
   container for isolated, runtime-credentialed execution.

## Phase-by-phase execution

Phases already exist in the execution manifest and are dependency boundaries.
The service currently selects **tasks**, not phases. The launcher adds phase
selection as a convenience:

```bash
forge-launcher run --repo <path> --phase phase-2 --yes
forge-launcher service submit --repo <path> --phase phase-2
```

The launcher resolves the selected phase to its task IDs, then the service
expands the normal prerequisite graph. A phase run therefore contains:

- all tasks in the selected phase
- all prerequisite tasks needed by those tasks
- prerequisite phases that the manifest declares

Completed prerequisite tasks replay from the completion ledger rather than
invoking a model. The run stops after the selected phase; later phases are not
pulled in.

The Console exposes the same behavior with **Select phase**, **Run phase**, and
**Run next phase** in the Tasks view.

### Phase completion and the source repository

Each successful task is already committed to the registered repository's
`refs/heads/forge/<base>` ref. The service deliberately does not advance the
checked-out branch or push to a remote.

When a phase is complete:

- the last task commit is the phase's code tip
- the run record, completion ledger, and evidence are the phase record
- no separate empty “phase commit” is required

To advance the checked-out branch after a completed run:

```bash
forge-launcher service merge <run-id>
git push origin <base-branch>
```

`service merge` performs a fast-forward only. If the branch has diverged or the
working tree is dirty, merge or rebase it explicitly instead. The service never
pushes to a remote.

If the next phase runs on another machine, take the runtime backup/restore path
as well as the repository. The source commits alone do not carry the completion
ledger or evidence.

## Current phase scope

This first implementation is **phase-gated execution**, not fully phase-isolated
execution:

- each phase is a separate run
- earlier phases are included as prerequisites and replay at no model cost
- a late-phase run can still reach the 1,000-task limit if the accumulated
  prerequisite set is large
- phase completion is derived from task statuses, not a new workflow primitive

A future optimization can resolve completion records at run bind time and omit
already-satisfied prerequisite tasks from the run entirely. That needs
service-authoritative “satisfied prerequisite” state, status projection, and
workflow-rollover changes, so it is deliberately separate from this first step.

## Automatic phase chaining

The first implementation requires an operator or CI job to start the next
phase. This is intentional: it creates a review boundary and avoids a new
scheduler layer.

For unattended operation, options are:

1. A CI job that submits one phase, waits for completion, then submits the next.
2. A future service-level phase-plan workflow with durable current-phase state,
   stop conditions, and approval gates.

Do not build automatic chaining as a shell loop around a weeks-long project
unless the external scheduler is itself durable. If MyForge owns the chain, it
should own it as a first-class workflow with evidence and failure semantics.

## Recovery checklist

Before a long pause or a move to another machine:

- push the repository and `forge/*` branches
- take `forge-launcher runtime backup`
- copy `runtime.env` separately
- record registered repository IDs and paths
- preserve harness grants and host-runner capability state
- stop the source runtime before restoring elsewhere

A runtime backup does not include target repositories, working trees, or
`runtime.env`. Restore requires matching database credentials and compatible
forge branch tips.

## What hosted P8 adds

The local profile does not provide:

- shared live state across machines
- shared artifact/checkpoint storage
- remote authenticated access
- multi-user isolation and quotas
- clean-host failover
- automated retention and garbage collection

P8 is the planned path for those properties. It is not implemented yet.

See also [ADR-066](adr/066-dapr-workflow-full-replacement-architecture.md),
[ADR-067](adr/067-bounded-workflow-histories-and-concurrency.md),
[ADR-086](adr/086-replay-integrated-task-completions.md),
[ADR-089](adr/089-run-timeouts-and-harness-activity.md),
[ADR-090](adr/090-phase-runs-and-host-default.md), and the
[local execution deep dive](local-execution-deep-dive.md).
