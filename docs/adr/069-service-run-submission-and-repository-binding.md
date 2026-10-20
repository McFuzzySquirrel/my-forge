# ADR-069: Service Run Submission and Repository Binding

**Status:** Accepted  
**Date:** 2026-10-20

## Context

P5-02 started a persistent Forge worker, but nothing could submit work to it.
For P5-03, the launcher needs a way to submit, query, and control runs through
the service. Three questions had to be settled first.

1. **The entry point.** The contract v1 submission (`RunSubmissionV1`) and the
   planner already exist. The service has no API, and runs bound in memory are
   lost when the worker restarts.
2. **Which repositories the container can reach.** The worker integrates
   commits into a target ref. It must not receive the host home directory,
   container sockets, or arbitrary paths.
3. **Which branch it writes.** A service run that advances the checked-out
   branch would race with the user's working tree.

ADR-068 requires a loopback-only local profile. It also requires that
credentials never reach harness environments.

## Decision

### Submission API

The worker serves `POST/GET /v1/runs`, `GET /v1/runs/{runId}`,
`GET /v1/runs/{runId}/events`, and `POST /v1/runs/{runId}/controls`.

- The API is published only on `127.0.0.1:${MYFORGE_API_PORT:-8483}`.
- Requests must use a loopback `Host`, carry no `Origin` header, and present
  a Bearer token, which is compared in constant time. Health probes are the
  only unauthenticated routes.
- The token (`MYFORGE_API_TOKEN`) is a fourth installation credential in
  `runtime.env`. Existing installations gain it with an atomic append. It is
  never passed to harness environments.
- Browser access is P5-05's operator session, not this token.

Accepted submissions live in a durable store, `forge_run_submissions`
(migration 6):

- The submission key is idempotent. Reusing a key with a different snapshot is
  a conflict.
- On restart, the worker rebinds every stored run before the workflow runtime
  starts, then reschedules runs whose workflow is missing.
- Replay controls allocate exactly one new logical attempt per control ID
  (`forge_replay_allocations`).
- Cancellation requests cancellation of active executions and waits until
  they stop.

Validation happens before anything is stored:

- the request shape and a 1 MiB size limit;
- the repository ID and a target ref under `refs/heads/`;
- that the harness and repository are available;
- the contract's secret-field rules;
- planner admission.

### Repository binding

`forge-launcher runtime repo add <path> [--id <id>]` registers a repository in
`repositories.json` in the runtime data directory.

- Only a repository root whose `.git` is a real directory can be registered.
  Linked worktrees, submodules, and paths that Compose cannot mount are
  rejected.
- The launcher generates a Compose override that mounts only
  `<repo>/.git` at `/repositories/<id>/.git` (`rw,z`).
- Registration changes take effect after `runtime stop` and `runtime start`.
- Rootless Podman maps container root to the host user, so objects and refs
  written by the worker stay owned by the user.

### Forge branch model

Service runs integrate into `refs/heads/forge/<base>`, never into a branch that
is checked out.

- `service submit` creates the forge branch at `HEAD`, or fast-forwards it when
  it is behind. It keeps a diverged forge branch, so unmerged Forge commits are
  not lost.
- The service rejects a target ref that is checked out.
- `service merge <runId>` fast-forwards the checked-out branch once the run is
  terminal.

### Worker image and harnesses

The worker image is built locally as `localhost/myforge-worker:<n>` from the
digest-pinned Node image plus Git. The tag is bumped whenever the Containerfile
changes.

The service offers only the deterministic `stub` harness. Real harness CLIs and
their credentials are not provisioned in the container. The execution contract
requires explicit credential grants rather than ambient host logins, so
supplying them needs a separate decision. Until then, real-harness execution
stays on the legacy `forge-launcher engine-run` path.

### Repository leases

A run releases its repository integration leases when it records a terminal
status. Without this, back-to-back runs on the same forge branch would wait for
the lease TTL. The fencing token is not reset, so tokens issued to the released
run stay stale. A replayed run acquires a new lease.

## Consequences

- The launcher can submit, follow, control, and merge service runs without
  touching generated files or infrastructure APIs.
- Engine-run, resume, the Console, and auto-build still drive the legacy engine
  until real harnesses run in the service. P5-03 stays open for that migration.
- Target repository `.git` data is not included in runtime backups. Users back
  up repositories separately.
- On SELinux hosts, `:z` relabels each registered `.git` directory with a shared
  container label.
