---
id: ADR-086
type: adr
title: Replay integrated task completions across runs
status: accepted
date: '2026-10-24'
---

# ADR-086: Replay integrated task completions across runs

## Context

Artifacts and checkpoints are run-scoped. The service keeps each run's artifact
store under that run's scratch directory, while the host runner deletes its
disposable clone after an attempt. A later run therefore cannot see a previous
run's `work.<task>` artifact even though the task's commit is already in the
target branch. Selecting a dependent task expands the selection to its
prerequisites; the engine would re-run those prerequisites, paying for the
harness again, or fail the dependent task's declared predecessor input because
the run-local artifact store is empty.

This became concrete after FND-01 was recovered from a failed host attempt and
committed directly to `forge/main`. FND-02 depends on FND-01 and consumes
`work.fnd-01`; a new FND-02 run had neither a completion record nor the work
artifact.

## Decision

Maintain a durable **task completion ledger** in the runtime data directory:
`FileTaskCompletionStore` records one entry per integrated task with the
repository, target ref, task ID, run ID, integration commit, base revision,
checkpoint digest, work/validation/bundle artifact refs, output files,
validation commands, and handoff digest.

On every `executeTask`:

1. Resolve the latest completion record for the task whose `commitSha` is an
   ancestor of the target ref head.
2. Replay only when the recorded validation commands match the current task and
   all expected outputs are recorded as produced.
3. Hydrate the completion's work artifact (and any predecessor artifacts) into
   this run's run-local `ArtifactStore` from the durable checkpoint store.
4. Return a normal complete outcome with the recorded evidence, without
   invoking the harness, creating a workspace, or integrating a new commit.

Normal integrations record the same ledger entry after the branch update. The
service passes the file-backed store; the dependency is optional for unit tests
and single-attempt execution.

## Consequences

- A new run can include already-integrated prerequisites, replay them at no
  model cost, and give dependants their declared artifact context.
- A failed attempt that never reached checkpoint capture still has no
  completion record. A verification run (for example, the stub harness on the
  host) can create one without a model call.
- Completion records are runtime state, not repository state; reinstalling the
  launcher or cloning the repository elsewhere does not carry them.
- A changed validation command set or a missing expected output disables the
  replay, so a stale record falls back to a real attempt.
- A missing or corrupt completion artifact fails closed instead of silently
  omitting the predecessor context.

## Alternatives considered

- **Prune completed tasks from the plan and create skipped statuses:** requires
  contract and run-status changes in addition to artifact hydration.
- **Resolve artifacts directly from a durable cross-run index:** useful for
  audit, but the completion ledger is sufficient to decide replay and to find
  the existing work artifact.
- **Re-run prerequisites in every later run:** simple but repeats model and
  validation work for commits that are already in the base.
