# ADR-091: Runtime build freshness and stale host-runner replacement

**Status:** Accepted
**Date:** 2026-10-24

## Context

The launcher binds its engine, worker container, and native host runner to code
loaded when the runtime started. Upgrading `forge-launcher` replaces files on
disk but does not change a process that is already running:

- `runtime start` calls `compose up -d`, which leaves a running `forge`
  container in place when its image and configuration did not change.
- `startHostRunner` returned immediately whenever the recorded PID was alive,
  so a runner started by an earlier launcher kept serving old code.

Operators therefore saw two symptoms after an upgrade: fixes did not take
effect until an unrelated `runtime restart`, and host harness activity enabled
in the Console produced no lines because the running host runner predated
support for it. The PID record carried only a PID and instance ID, so the
launcher could not tell that the process was stale.

## Decision

Record the launcher version that started the runtime and the host runner:

- `runtime-applied-repositories.json` gains an optional `launcherVersion`.
- `host-runner.pid` gains an optional `launcherVersion`.

Use that record to fail closed on staleness:

- `runtime start` compares the applied launcher version with the installed one.
  When they differ it runs the same stop/down/up path as `restart`, so the
  worker container and host runner both load the installed build. A missing
  version (a record written before this change) counts as stale.
- `startHostRunner` replaces a live runner started by another version instead
  of reusing it.
- `getRuntimeAdminState` reports `launcherVersion`,
  `appliedLauncherVersion`, and `hostRunnerLauncherVersion`, and folds the
  build mismatch into `restartRequired`. The Console Runtime page explains the
  mismatch and the automatic replacement.

The comparison is an exact version-string match, not a semantic range: the
runtime is built from one installed package tree, so only that exact build is
safe to reuse.

## Consequences

- Installing a launcher update and running `runtime start` now applies it
  without a separate restart.
- Starting or restarting replaces a stale host runner. An in-flight host
  attempt loses its lease and is recovered by the service's normal retry path;
  `runtime start` is an explicit operator action, so this is acceptable.
- `runtime status` can distinguish "runtime is current" from "mounted
  repositories changed" and from "a different launcher build is applied".
- A downgrade is still unsupported for the database schema; this change only
  ensures the code that runs matches the installed package.

## References

- [`scripts/forge-launcher/scripts/runtime.ts`](../../scripts/forge-launcher/scripts/runtime.ts)
- [`scripts/forge-launcher/scripts/runtime-host-runner.ts`](../../scripts/forge-launcher/scripts/runtime-host-runner.ts)
- [`scripts/forge-launcher/scripts/console/dashboard/views/runtime.ts`](../../scripts/forge-launcher/scripts/console/dashboard/views/runtime.ts)
- ADR-074 workflow-definition upgrade qualification
- ADR-089 run timeouts and harness activity
