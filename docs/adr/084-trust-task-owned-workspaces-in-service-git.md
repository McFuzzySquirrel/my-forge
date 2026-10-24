---
id: ADR-084
type: adr
title: Trust task-owned workspaces in service-side Git operations
status: accepted
date: '2026-10-24'
---

# ADR-084: Trust task-owned workspaces in service-side Git operations

## Context

Host execution runs the native harness against a disposable clone and returns a
workspace delta to the service. The service prepares its own workspace for the
attempt and, when task UID isolation is enabled, chowns that workspace to the
task identity (a UID in the 20,000–60,000 range) while the service process keeps
running as root.

After a successful harness run, the service applies the returned delta and
inspects the workspace with Git. Git's `safe.directory` ownership check refuses
a repository owned by another UID. The first host run that finished a real task
therefore failed in `applyWorkspaceDelta` with:

```text
fatal: detected dubious ownership in repository at '/tmp/myforge-task-scratch/workspaces/...'
```

The attempt was classified as `execution-error`, its workspace was discarded,
and the model's work was never integrated. The same ownership mismatch also
made `captureWorktree` return `null`, silently disabling the no-op heuristic.

## Decision

Pass `-c safe.directory=<workspace>` to every service-side Git command that
operates on a task workspace:

- the shared `runGit` helper and the repository clone in `workspace-diff.ts`;
- `captureWorktree` in `verify.ts`.

Checkpoint capture already trusts its working directory. Trust is scoped to the
repository path for the duration of one command; the global Git configuration is
not changed and `safe.directory=*` is never used. Task UID isolation and the
root service process remain unchanged.

### Harness commits

A harness may commit its work in the disposable clone before exiting. Delta
capture previously required the workspace HEAD to equal the accepted base
revision, so that otherwise successful attempt was rejected as an execution
error and its work was discarded.

Delta capture now accepts a HEAD that equals or descends from the base. It
still rejects an unrelated history. The delta is produced by diffing the base
tree against the current working tree, so committed and uncommitted changes are
flattened into the same transferable patch.

## Consequences

- A host-runner result is applied, verified, checkpointed, and integrated even
  when the workspace is owned by the task UID.
- A harness commit is captured in the delta instead of being rejected, while an
  unrelated HEAD remains an error.
- No-op detection works again, because `captureWorktree` can read the
  task-owned working tree.
- Service-side Git commands still reject unrelated repositories; only the
  workspace passed to the command is trusted.
- The target repository's integration path is unchanged: the registered
  repository is root-owned inside the container, and the worker path runs as
  the registered repository's owner.

## Alternatives considered

- **Run service-side Git operations as the task UID:** correct in principle, but
  it requires dropping privileges around every Git call and keeping the
  service's scratch, journal, and receipt access working as root.
- **Chown the workspace back to root before Git operations:** creates a window
  where the task owns files the service is about to rewrite, and complicates
  cleanup if the chown fails partway through.
- **Set `safe.directory=*` globally:** removes the ownership check for every
  repository the service can reach, which is broader than this boundary needs.
