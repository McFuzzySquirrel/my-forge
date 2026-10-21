# ADR-076: Per-Task Process Privilege Isolation

**Status:** Accepted  
**Date:** 2026-10-21

## Context

ADR-075 identified that repository-supplied harness and validation processes
ran as container root. The worker mounts every registered repository's `.git`
read-write and keeps the operator-managed harness-grants file in the same
container. Root task processes could alter Git hooks or configuration in any
registered repository and read all harness grants.

## Decision

- The service assigns every live task attempt a distinct UID/GID from
  20,000–60,000. The allocation is released only after the attempt's workspace
  is removed. If process-tree cleanup is unconfirmed, that UID is quarantined
  for the rest of the worker lifetime.
- Harness and validation commands start through `setpriv` with that UID/GID
  and cleared supplementary groups. The worker image installs `util-linux`
  for `setpriv` and uses image tag `localhost/myforge-worker:3`.
- The service owns the integration repository and the grants file. Each task
  gets a private, task-owned clone and home under `/tmp/myforge-task-scratch`.
  The selected harness receives only its explicit provider credentials in its
  environment; validation commands receive none.
- Worker Git commands mark only the exact task workspace as safe. That
  configuration is not passed to task processes.
- Qualification commands use the public `MYFORGE_LOGICAL_ATTEMPT` value to
  simulate a first-attempt failure without writing a marker outside the
  isolated workspace.

## Evidence

On rootless Podman 4.9.3, the live probe confirmed UID/GID 20,000 with no
supplementary groups; workspace write access; unreadable
`/run/myforge/harness-grants/grants.json`; and failed writes to the registered
source repository's `.git/hooks`. The automated F11 qualification repeats the
UID, home, grant-file, and source-Git write checks. F01–F10, all four backup
scenarios, and both upgrade scenarios passed with task UID isolation enabled.
The engine suite passes 189 tests (one root-only process assertion is skipped
on this non-root host).

## Residual risk

The worker still mounts every registered `.git` directory into the same
container. The unprivileged task UID cannot modify those mounts, but the live
probe confirms it can read their metadata and objects. This is a residual
cross-repository confidentiality exposure. Do not treat mutually untrusted
repositories as isolated from each other; deny this read access before
cutover if the trust boundary requires repository confidentiality.

The task UID is process and file-permission separation, not a complete
container, syscall, or network sandbox. macOS and Windows Podman-machine
qualification remains separate P6-05 work.

## Consequences

- The root-owned Git hooks/configuration and harness-grants exposures from
  ADR-075 are mitigated without asking users for another GitHub repository
  credential.
- Git workspaces and homes are disposable and cannot be shared across live
  attempts by filesystem permissions.
- A service that cannot find `setpriv`, allocate an identity, or confirm
  process cleanup must fail the attempt rather than run it as root or reuse an
  uncertain identity.
