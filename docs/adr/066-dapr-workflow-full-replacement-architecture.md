# ADR-066: Dapr Workflow as the Full-Replacement Runtime

**Status:** Accepted  
**Date:** 2026-10-13

## Context

MyForge's current workflow engine provides resumable local execution, but its
authoritative state and controls are file-based. The Console also mutates that
state, so replacing only the scheduler would leave multiple writers and
duplicated lifecycle semantics. Keeping two production engines would preserve
that ambiguity and double the conformance burden.

The accepted P0/P1 gates established the compatibility inventory and budgets,
verified released Dapr Workflow APIs, and exercised a rootless Podman spike.
The live evidence proves a stub workflow's timer and approval waits survive
worker/sidecar and full-stack clean restarts on one host. It does not qualify
crash or partition recovery, cross-host failover, cancellation, retries,
backup/restore, local-model execution, or production repository mutation.

The measured versions and image digests are recorded in
[`tools/dapr-spike/evidence.json`](../../tools/dapr-spike/evidence.json).
The operator accepted P1-GATE on 2026-10-13; that acceptance authorizes this
decision and P2 contract work, not production cutover.

## Decision

Adopt **one Dapr Workflow engine with local and hosted deployment profiles** as
the replacement direction. Keep the current engine unchanged as the production
runtime until the later migration and release gates pass. Never allow both
engines to write the same run or target branch.

### Verified baseline

Use the following exact versions as the P1 qualification baseline, not as a
promise that every future deployment has already been qualified:

| Component | Qualified version |
|---|---|
| Dapr runtime, Placement, and Scheduler images | 1.18.7, pinned by digest in the evidence |
| JavaScript Workflow SDK (`@dapr/dapr`) | 3.18.0 |
| Durable Task JS package | 1.0.0 |
| Node on the host | 24.15.0 |
| Node in the spike worker | 24.11.1 |
| Rootless Podman | 4.9.3 |
| PostgreSQL image | 17.6-bookworm, pinned by digest in the evidence |
| PostgreSQL state component | `state.postgresql/v2` |
| TypeScript in the spike | 7.0.2 |

Re-qualify upgrades against released APIs and the applicable gates. In
particular, the tested JavaScript SDK has a broad `TWorkflow` type alias, and
its released activity call does not expose a retry-policy argument. Do not
claim static registration safety or qualified retry behavior from the live
spike.

### Runtime and ownership boundaries

- Start with one TypeScript/JavaScript workflow application that registers all
  workflows and activities. Workflow code remains deterministic; filesystem,
  Git, CLI, provider, and other nondeterministic work runs in activities.
- Keep Dapr workflow history, application-owned operation receipts and
  repository fencing, and immutable artifact data in separate persistence
  concerns. Persist PostgreSQL workflow state and Scheduler state independently;
  never write application records into Dapr's internal workflow tables.
- Use the rootless local Podman profile with private infrastructure ports and
  persistent workflow, Scheduler, and artifact storage. The P1 pod used no
  network and published no ports. Any later host API must be loopback-only until
  its own authentication and exposure gates pass.
- Treat local persistent volumes as single-host restart recovery, not
  high-availability or cross-host failover. Hosted deployment and reconstruction
  of Git/workspace state require separate qualification.
- Preserve canonical requirements, manifest compilation, harness adapters,
  task verification, artifact projection, and isolated Git workspaces behind
  explicit interfaces. Snapshot the manifest, resolved contracts, harness
  selection/configuration version, and workflow definition version at run
  creation.
- Do not adopt Dapr Agents, independent JavaScript activity applications, a
  custom workflow protocol, or containerized target builds in this increment.

P2 records the execution boundary and package ownership in
[`dapr-execution-boundary.md`](../features/dapr-execution-boundary.md) and its
[versioned contract](../contracts/dapr-execution-v1.md). The intended service
source is `tools/dapr-engine/`; reusable execution code lives behind a
Dapr-independent module boundary within that service source. The launcher
release will own packaging/deployment resources and its client; repository
bootstrap must not install a second scheduler into each target repository.

### Rollout

P2 defines and extracts reusable contracts and utilities without changing
production commands or runtime behavior. P3/P4 implement and qualify durable
effects and a local vertical slice. Launcher and Console migration, recovery
qualification, and legacy retirement remain gated by P5/P6/P7. Hosted
availability remains a distinct P8 gate.

If a later gate shows released SDK support or required semantics are
insufficient, stop production replacement work, retain the current engine, and
revise this decision. Do not turn the spike into a permanent second backend.

## Consequences

- One orchestration model owns the future run lifecycle, avoiding two competing
  production writers and duplicate pause, replay, retry, and recovery behavior.
- Local users still need the packaged Dapr infrastructure; Podman makes it
  rootless and self-contained, not infrastructure-free.
- The version table is a reproducible spike baseline, not a release support
  matrix. Cancellation, retries, failure recovery, artifact limits, and
  cross-host operation still need their later tests.
- Dapr activities are at least once. Provider calls may repeat when a result was
  not durably recorded, and exactly-once external effects are not promised
  without provider idempotency.
- The old engine remains the migration reference and production runtime until
  cutover; its state must not be imported as live Dapr history implicitly.

## Relationships

- Continues the full-replacement direction in
  [`docs/research/dapr-workflow-and-agents.md`](../research/dapr-workflow-and-agents.md).
- Relies on the accepted P0/P1 evidence in [`plan.md`](../../plan.md) and
  [`tools/dapr-spike/evidence.json`](../../tools/dapr-spike/evidence.json).
- Authorizes P2 only; it does not supersede the later migration and release
  gates in [`plan.md`](../../plan.md).
