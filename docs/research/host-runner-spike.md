# Research: Local Host Harness Runner

**Date:** 2026-10-22
**Status:** Sandbox evidence retained as historical; user clarified native host execution
**Related:** [HOST-RUNNER feature](../features/local-host-harness-execution.md),
[issue #18](https://github.com/McFuzzySquirrel/my-forge/issues/18),
[SDR-20261022-002](../decisions/sdr/SDR-20261022-002-sandboxed-host-harness-runner.md),
[current direction: ADR-081](../adr/081-native-local-harness-execution-without-task-sandbox.md),
[originating SDR-20261022-003](../decisions/sdr/SDR-20261022-003-native-local-harness-execution-without-task-sandbox.md)

## Question

Can Dapr remain the workflow orchestrator while a launcher-managed runner uses
the operator's locally installed harness CLI on the same machine as the project?
The initial sandbox investigation was superseded by the user's requirement for
native, unsandboxed CLI execution.

## Revised user direction

The user clarified that MyForge should require locally installed harness CLIs
and let Dapr invoke them directly on the machine where the user is working,
without an OS or OCI task sandbox. The host process therefore runs under the
logged-in user's account and the harness can access the user's files, processes,
network, and CLI authentication. The per-project capability authorizes
Dapr-to-runner requests; it does not constrain the harness. The feature contract
now requires explicit host-mode opt-in and a full-permissions warning. The
rootless-container and Landlock probes below are historical alternatives, not
the selected direction.

## Current execution boundary

`ExecutionHost.prepareWorkspace` resolves a registered repository, reads the
accepted target ref, creates a fresh clone, removes its remote, and checks out
the selected base revision. With task UID isolation enabled, that workspace is
created under `/tmp/myforge-task-scratch` inside the worker container; this path
is not currently a host-visible mount. The worker's compose configuration
mounts runtime data and registered repositories, but not task scratch.

This means a host runner cannot safely receive a container path and open it
directly. A request should identify a registered repository and immutable base
revision, not an arbitrary host path. A host-side clone from that registered
repository may reconstruct the same clean task starting point, but returning
only task-produced changes to the Dapr worker still needs a validated,
integrity-checked result format.

The worker API is published on a host loopback port. A direct request from the
worker container to a host listener bound only to host loopback is not a
working transport. Evaluate a runtime-owned Unix socket mounted into the
worker or a host runner that polls the existing loopback service API; do not
open a listener on a general host interface.

## Linux sandbox probes

The environment is Linux kernel `7.0.0-38-generic`, rootless Podman `4.9.3`,
Node `v26.12.0`, and Python `3.12`. `bwrap` and `unshare --user` cannot create a
user namespace here. A user-systemd unit did not hide a host-home sentinel with
`ProtectHome=yes`, and its `BindPaths` workspace setup failed with
`226/NAMESPACE`; these settings are not a qualified solution in this
environment.

### Rootless OCI container with the host CLI mounted read-only

Rootless Podman reports `true` for its rootless mode and can start an
ephemeral task container with a read-only root filesystem, a writable workspace
mount, an isolated writable temporary home, no capabilities, no-new-privileges,
a PID namespace, and bounded process/memory/CPU settings.

Using `localhost/myforge-worker:4` as the test base image, the probe mounted the
host OpenCode and Copilot executables at separate read-only paths and invoked
their version commands with `--network=none`. Both ran successfully:

| CLI | Host executable result | Image-pinned version |
|---|---|---|
| OpenCode | `opencode v2.0.32` | `2.0.32` |
| GitHub Copilot CLI | `1.0.102` | `1.0.100` |

The boundary probe confirmed that the host home and an unrelated host path were
not mounted, the host process ID was absent from the container PID namespace,
the mounted host executable was read-only, and a task could write to its
workspace. The CLI version checks used a disposable `HOME`; no provider
credential/profile was mounted. These are smoke tests, not task-execution,
provider-authentication, or network qualification.

This proved that local CLI binaries can run from a read-only mount in a
container, but the user rejected that execution model. Do not use this as the
implementation target.

### Landlock filesystem probe

A one-off Linux Landlock ABI 8 probe on this kernel passed these filesystem
checks:

- reads and writes to the host home and an unrelated host directory are denied;
- a workspace symlink cannot reach an outside file;
- one explicitly allowed scoped-profile directory remains readable;
- an outside executable is denied, while the workspace remains writable; and
- a child process inherits the same restrictions.

This is filesystem evidence only. Landlock does not by itself qualify process
isolation, signal/ptrace boundaries, process-tree cleanup, resource limits, or
network policy. It is not part of the selected native-host execution direction.

## Workspace and transport candidates

| Candidate | Benefits | Risks and evidence still needed |
|---|---|---|
| Host-visible shared scratch | Avoids copying task files and makes the produced workspace directly available to the worker. | Requires a new host bind mount; current scratch is container-local. Must qualify UID/GID mapping, permissions, SELinux labels, stale-workspace cleanup, and cross-project access. |
| Bounded workspace archive | Keeps worker and host filesystem ownership separate and allows explicit content/hash validation. | Must reject traversal, links, special files, oversized payloads, and stale or replayed results; source repository and `.git` data may be large. |
| Reconstruct from registered repository and base revision | Matches the current clean-clone behavior without accepting a path or transferring the full input tree. | Host runner must resolve the repository only through the registry, verify the exact base commit, and return a bounded, verifiable change set for Dapr validation and integration. |

The third option is the leading input-workspace candidate because the execution
host starts each task from a fresh clone at its accepted base revision. It has
not yet been compared against actual Dapr/host Git fixtures. A result-transfer
format and a loopback/Unix-socket dispatch transport remain open.

## Initial implementation candidate

The current service publishes its HTTP API on a host loopback port and requires
a bearer token; the service itself listens inside the container. The
containerized worker cannot call a host listener bound only to loopback, but a
host runner can initiate requests to the published loopback API. A runner poll
or long-poll endpoint with project-scoped authorization is therefore the
transport candidate; it would not add a general host listener.

The worker's task workspace is under `/tmp/myforge-task-scratch` in the
container, and `runtime_data` is a named volume rather than a host-visible
directory. Direct shared scratch would require a new host bind mount and
cross-platform path/permission qualification. The leading workspace candidate
is for the host runner to resolve the registered repository by ID through the
launcher registry, clone the exact accepted base revision into a private
temporary directory, and return a bounded binary Git diff. The Dapr worker
would apply that diff to its own workspace and continue through existing
validation and integration. The request contains repository identity and
revision, never a host path or shell command.

This is an implementation candidate, not a qualified design. Before production
integration, test base-revision fencing; binary, deleted, renamed, untracked,
and mode-changed files; patch size limits and path safety; duplicate/replayed
requests; process cancellation and cleanup; API and project capability
authorization; and Linux/macOS/Windows transport behavior.

## Remaining native-runner work

The unsandboxed process model is a deliberate user trust decision, not an
isolation guarantee. The native runner still needs:

1. a typed request/result and cancellation contract that rejects arbitrary
   commands, caller-supplied paths, unauthorized projects, and stale attempts;
2. a host-initiated polling/long-poll transport to the existing loopback API
   with durable leases and project-scoped authorization, without exposing a
   general network listener;
3. a host-side clone from the registered repository ID and accepted base
   revision, then a bounded, integrity-checked binary Git diff imported into
   the Dapr workspace through existing validation/checkpoint/Git integration;
4. environment handling that preserves the user's normal CLI authentication
   but never passes MyForge/Dapr service tokens or the runner capability to the
   harness subprocess;
5. explicit host-mode opt-in and a clear warning that the harness has the
   logged-in user's full OS permissions; and
6. native process launch, cancellation, and credential behavior qualification
   on every OS MyForge intends to support.

The CLI runs on the user's host OS, but this Linux-only evidence does not yet
qualify Windows or macOS. Do not claim support for an OS until its transport,
process cleanup, paths, and CLI authentication have been tested.
