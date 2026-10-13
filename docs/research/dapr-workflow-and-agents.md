# Research: Dapr Workflow and Agents for MyForge

**Date:** 2026-10-12
**Revised:** 2026-10-13
**Status:** Proposed full-replacement roadmap for the MyForge fork; not implemented

## Question

How should this fork replace its file-based orchestration engine with Dapr
Workflow, while retaining a practical local experience through Podman and
enabling recovery on another host?

This revision supersedes this document's original optional-backend recommendation.
It changes the proposed direction, not current commands or runtime behavior.

## Current state

MyForge already has a durable local workflow engine:

- `docs/PRD.md` plus `docs/features/*.md` own the requirements;
  `docs/EXECUTION-MANIFEST.json` is their compiled execution snapshot.
- `docs/WORKFLOW-STATE.json` persists task state and retry history.
- The engine supports resume, replay, retries, cancellation, approvals,
  verification gates, audit events, and bounded parallel execution.
- Harness adapters isolate orchestration from Copilot, Claude, OpenCode, and
  OpenAI execution.
- The artifact store persists typed task handoffs and projects compact context
  into later tasks.
- Concurrent repository tasks use isolated Git worktrees, while the engine
  remains the single writer of authoritative state and integrated changes.

This makes a run resumable when its repository and generated runtime files are
available. It does not provide shared remote state, distributed ownership,
automatic failover, or horizontal worker scaling. Moving execution to another
host also requires reconstructing the repository, credentials, dependencies,
generated files, and any uncommitted runtime state.

## Options

### Keep the existing engine only

This preserves MyForge's lightweight, Git-native, offline-friendly operation.
It remains a reasonable choice for the upstream project's lightweight local
experience, but does not meet this fork's full-replacement direction.

### Add Dapr Workflow as an optional backend

Dapr Workflow could provide durable distributed execution, shared workflow
state, timers, external events, recovery after worker failure, and horizontally
scaled workers. Keeping two production engines would preserve a zero-infrastructure
mode, but double the orchestration semantics and conformance burden. Use the
existing engine as a temporary migration reference, not a permanent backend.

### Adopt Dapr Agents

Dapr Agents may become useful for long-lived conversational agents, durable
agent-to-agent messaging, and cross-run memory. It overlaps more substantially
with MyForge's personas, harness adapters, artifact handoffs, and task
orchestration. Its value and supported runtime maturity should be reassessed
after a workflow proof of concept.

### Replace the engine with Dapr

Replace the scheduler, durable state ownership, and control plane, not the entire
Forge product. Retain requirements authoring, manifest compilation, task
contracts, harness adapters, verification, typed artifacts, and workspace
isolation wherever their interfaces allow reuse.

This is the recommended target for this fork, subject to the gates below.
Podman packages the mandatory infrastructure for local users; it does not remove
that infrastructure or provide cross-host recovery by itself.

## Recommendation

Build **one Dapr Workflow engine with local and hosted deployment profiles**.
Prove a small vertical slice before retiring the old engine. Do not adopt Dapr
Agents in the first iteration: durable task orchestration does not require a
second agent framework.

The proof of concept should preserve:

- canonical requirements and the compiled execution manifest as distinct contracts;
- harness adapters as the model and CLI execution boundary;
- existing task verification and structured handoffs;
- artifact projection as the authoritative task-to-task context mechanism;
- worktree sandboxing and serialized Git integration;
- local execution without Kubernetes or a cloud account, using persistent Podman
  services.

### Evaluation of the original plan

The activity boundary, compact artifacts, verification gates, and recovery tests
remain sound. Change these assumptions:

- **Two backends:** replace with one engine deployed locally or remotely.
- **Portable state:** also persist workspace checkpoints and Scheduler storage;
  workflow state alone cannot restore uncommitted work.
- **Leases:** actor placement handles workflow ownership, not exclusive Git
  integration across distinct runs. Add repository fencing separately.
- **Independent workers:** validate SDK support before promising separate activity
  deployments; same-app replicas register the same workflows and activities.
- **Console compatibility:** files and PID signalling currently form part of the
  control interface. Replace these explicitly rather than swapping only the DAG loop.
- **Offline operation:** cached containers and dependencies can work without cloud
  infrastructure, but cloud harnesses still need network access.

### SDK and deployment evidence

Official source documentation reviewed on 2026-10-13 lists JavaScript Workflow
authoring and stable JavaScript SDK support. The general JavaScript service
client alone is not a workflow worker: validate workflow runtime registration,
activities, external events, timers, and recovery against pinned releases.
The current multi-application workflow documentation says JavaScript support is
planned, not available. Start with a single workflow application; do not base
the first release on independent TypeScript activity applications.

The sources were the official repositories' default-branch documentation and
may describe unreleased features. No deployment has been tested here. Record
exact runtime/SDK/image versions and released feature support during the spike.
If the selected JavaScript release cannot meet the required semantics, decide
explicitly between a supported orchestration language with a Node execution
service and waiting for JavaScript support; do not silently build a custom
workflow transport.

Dapr documents Podman initialization explicitly. Its default development
initialization is a useful spike path, not the production topology proposed below.

## Expected benefits

- Resume a durable run on a different worker against shared state.
- Recover automatically from process or node failure.
- Express retry delays, timeouts, human-review waits, and approvals durably.
- Enforce distributed run ownership through leases.
- Scale same-application workers initially; independent activity scaling is a
  later, SDK-gated capability.
- Expose durable run status to the Console, with reconnectable event notifications.
- Gain standard tracing, metrics, health checks, secret references, service
  invocation, and pub/sub integration.

Dapr cannot resume a model or CLI process in the middle of an invocation.
Harness calls must be retryable activities whose outcomes and side effects are
idempotent. Activity execution is at least once. Recovery may repeat a paid model
call or external API operation when a result was not durably recorded; exactly-once
external effects cannot be promised without provider support.

## Target architecture

Use a single service boundary:

1. **Launcher and Console** - submit manifests, query runs, and request controls
   through an authenticated Forge API.
2. **Dapr workflow application** - evaluates task readiness and schedules durable
   activities, timers, and approval waits.
3. **Execution activities** - reuse Node harness adapters, verification, artifact
   projection, and isolated workspaces.
4. **Integration coordinator** - serializes accepted changes per repository and
   target branch, with durable ownership and fencing.

Local and hosted profiles use the same task semantics and API. Start with one
workflow application registering all workflows and activities. Separate worker
applications are a later option only where the selected SDK supports them.

One workflow instance represents one `runId`. Activities perform all
nondeterministic work, including harness invocation, filesystem operations,
validation, artifact persistence, sandbox integration, and Git commits.
Workflow code only evaluates durable state and schedules activities. It must not
read files, invoke CLIs, use wall-clock time or random IDs, or make direct network
calls. Snapshot the manifest, its digest, resolved contracts, harness configuration,
and workflow definition version at run creation; source edits require explicit
recompilation and reconciliation.

Use three distinct persistence concerns:

- **Workflow history/state:** durable scheduling, task status, attempts,
  dependencies, timers, and approval waits, owned by Dapr Workflow.
- **Execution artifacts:** outputs, validation evidence, logs, and commit
  references.
- **Agent memory:** reusable summaries or facts across tasks or runs.

Keep application idempotency receipts and repository leases in a separate
application-owned namespace/table; never mutate Dapr's internal workflow records.

Store compact metadata in the workflow state store and large or sensitive artifacts
in an appropriate object store. Persist references and integrity metadata in
workflow state. A searchable or vector store remains necessary if semantic
memory is later required; Dapr state storage alone does not provide semantic
retrieval.

### Local Podman profile

Treat "a container" as a small managed stack, not an all-in-one image:

| Component | Local proposal | Persistence |
|---|---|---|
| Forge application and Dapr sidecar | Rootless Podman pod with explicit internal addresses | Rebuildable images; no authoritative state in container layers |
| Placement | Internal-only Dapr service | Reconstructs ownership; not the Git lock |
| Scheduler | Internal-only Dapr service | Persistent Scheduler/etcd data volume |
| Workflow state and application receipts | PostgreSQL with a Workflow-compatible actor state component | Database volume and backup |
| Artifacts/checkpoints | Filesystem volume behind an artifact-store interface | Separate volume; hosted profile uses shared object storage |
| Task workspaces | Managed scratch clones/worktrees | Disposable after durable checkpoint publication |

PostgreSQL is a proposed default, not a deployed dependency. Validate its component
version, transactions, ETags, and actor-state configuration against the chosen
Dapr release. Redis remains a valid alternative if its durability and backup
settings meet the same tests; do not rely on an ephemeral development Redis.
Persist both workflow state and Scheduler data, and test a consistent restore.

The documented spike command is `dapr init --container-runtime podman`, followed
by host-process application/sidecar execution. The packaged profile must supply
its own explicit service configuration; do not assume that command alone creates
the full stack above.

Start with Linux rootless Podman. Validate UID/GID mapping, SELinux labels, volume
ownership, Git safe-directory handling, resource limits, and signal propagation.
macOS and Windows need a Podman machine VM; separately test host/VM networking,
path translation, file watching, and mounted-repository performance. Do not
assume Linux host networking works identically on those platforms.

Prefer managed workspaces over exposing a user's whole home directory or dirty
working tree. Support a narrowly scoped repository mount only with explicit
consent and a dirty-tree policy. Do not mount a container-engine socket into agent
workers; target projects needing containers require a separately approved build
isolation strategy.

Add a launcher-managed lifecycle with start, health/status, stop, backup/restore,
upgrade, and separately confirmed destructive reset operations. These are proposed
capabilities, not existing commands. Publish only the Forge API/Console on loopback;
keep sidecar APIs, PostgreSQL, Placement, and Scheduler internal. Scope secrets to
the selected harness and repository, redact logs, and authenticate control requests.
Pre-pull images and dependencies for offline use with a local harness/model.
Single-host persistence supports restart, not high availability.

### Recovery, Git integration, and controls

- Identify work by repository, run, task, logical attempt, operation, and manifest
  digest. A redelivery reuses its logical attempt key; an explicit retry/replay
  receives a new key.
- Persist immutable artifacts and checkpoint references before reporting success.
  Retain base commit, resulting tree/commit, patch or bundle (including new files),
  validation evidence, and toolchain metadata. Publish all required objects to
  shared storage before claiming cross-host recoverability.
- Integrate only through a repository/target-branch coordinator using expiring
  leases plus monotonically increasing fencing tokens. Reject stale owners at
  the mutation boundary, check the expected branch head, and reconcile an already
  applied commit after a crash. A TTL lock alone cannot stop a resumed old worker.
- Record durable operation receipts and reconcile effects after a crash between
  Git/artifact mutation and receipt persistence. Fail closed on ambiguous outcomes;
  a stable idempotency key alone is not an implementation of idempotency.
- Replace Console file writes and PID signals with acknowledged API requests.
  Distinguish graceful pause, resume, stop, terminal cancellation, and explicit
  task replay. Preserve or explicitly migrate today's stop semantics; terminating
  a workflow does not automatically kill a harness subprocess.
- Bind human approvals to run/task, manifest digest, reviewed evidence digest,
  operator identity, and request ID. Reject stale or unauthorized approvals.
  Deduplicate control events, and suppress late results from cancelled attempts.
- Export `WORKFLOW-STATE.json`, `PROGRESS.md`, and audit records as optional
  read-only compatibility views. They are not a second writable state authority.
  Use queryable status and sequenced events so the Console recovers after reconnect;
  pub/sub notifications alone are not an audit ledger.
- Version workflow definitions and activity contracts; drain old runs or keep
  compatible workers until completion. Replay of durable history must not be
  confused with the existing user command to rerun a task.

## Implementation plan

### Phase 1 - Prove the runtime and local deployment

- Pin released Dapr runtime, Workflow SDK, images, and state component versions;
  verify TypeScript authoring and every required feature in that release.
- Bring up the rootless Linux Podman stack with persistent volumes; run a stub
  activity, durable timer, and external approval event across an application restart.
- Define portability and recovery scenarios, operational constraints, and
  measurable success criteria.
- Inventory local state, artifact, control, approval, workspace, credential,
  and Git assumptions that must be reconstructed remotely.
- Define the boundary between orchestration decisions and nondeterministic
  activities.

**Exit criteria:** reproducible local setup and a restart test with recorded
versions, support limitations, state/artifact stores, and explicit non-goals.

### Phase 2 - Extract reusable execution contracts

- Separate task execution utilities from the old scheduler without changing
  manifest compilation or validation semantics.
- Define versioned API models for runs, tasks, attempts, controls, approvals,
  artifacts, and lifecycle events.
- Capture conformance cases from existing tests: phase/task dependencies,
  skipped tasks, manual selection with transitive dependencies, per-owner
  concurrency, retries, no-op checks, structured results, and human-review gates.
- Inventory launcher, Console, bootstrap, workflow skill, and auto-build polling
  dependencies on files and process IDs.

**Exit criteria:** execution utilities retain their existing tests and a parity
matrix identifies every behavior to preserve or deliberately migrate. No second
production scheduler is introduced.

### Phase 3 - Implement one end-to-end Dapr run

- Map a MyForge run to a durable workflow instance keyed by `runId`.
- Implement activities for harness execution, verification, artifact writes,
  sandbox integration, and Git commit.
- Implement durable receipts and a fenced repository integration coordinator.
- Deliver human-review approvals and control requests as external workflow
  events.
- Expose status and acknowledged controls through the Forge API; export
  compatibility views for readers not yet migrated.
- Complete a two-task dependency chain, a failed verification/retry, and an
  operator approval with the stub harness before enabling a real harness.

**Exit criteria:** the proof of concept completes a representative manifest and
produces equivalent task results, artifacts, audit evidence, and commits.

### Phase 4 - Prove recovery and parity

- Terminate the orchestration host during idle, activity, retry-delay, and
  human-review states, then resume on another worker.
- Exercise duplicate activity delivery and verify idempotent artifact and Git
  behavior.
- Test timeout, cancellation, late results, replay, exhausted retries, stale
  fencing tokens, duplicate/stale approvals, and conflicting repository writes.
- Crash between artifact publication, Git integration, and receipt persistence.
- Restart the whole Podman stack without deleting volumes, restore backups, and
  test a compatible workflow application upgrade.
- Verify workspace reconstruction, dependency preparation, secrets, and
  credentials on a clean worker.
- Compare the old engine's conformance cases with Dapr results; measure local
  startup, latency, resource use, and recovery time against agreed budgets.
- Prove a fresh hosted worker can restore solely from shared stores and Git;
  a local filesystem volume is not evidence of cross-host recovery.

**Exit criteria:** one accepted artifact set and integrated change per logical
attempt despite duplicate delivery, no lost accepted results, and no manual state
editing on recovery. Document unavoidable duplicate provider calls separately.

### Phase 5 - Cut over and retire the old scheduler

- Migrate launcher and Console to the service API; select a deployment profile,
  not an orchestration backend.
- Freeze new legacy runs, drain active runs, and archive their files. Prefer
  starting new Dapr runs from verified checkpoints over importing arbitrary
  partially running state. Build an explicit validated importer only if needed.
- Keep a rollback release and pre-cutover backup; never let both engines write
  the same run or branch. Dapr histories cannot simply be opened by the old engine.
- Add deployment templates, state-store configuration, secret references,
  health checks, tracing, metrics, retention, and backup guidance.
- Document migration, rollback, compatibility, and operational ownership.
- Add integration and failure-injection tests plus API/Console conformance tests.
- Remove the old DAG loop, writable file-state control path, and legacy polling
  only after callers have migrated. Preserve historical ADRs and audit exports.
- Validate macOS/Windows Podman profiles before claiming desktop platform parity.

**Exit criteria:** Dapr is the sole supported engine for this fork; local startup,
shutdown, backup, migration, and rollback are documented and tested. Hosted
deployment adds shared storage, authenticated access, worker isolation, and
high-availability service topology rather than changing orchestration semantics.

### Phase 6 - Reassess Dapr Agents

- Evaluate Dapr Agents only for requirements not met by workflows and artifacts,
  such as durable conversational identity, cross-run messaging, or semantic
  memory.
- Compare it with a smaller dedicated memory interface and searchable store.
- Adopt it only if it preserves harness portability and avoids duplicating
  MyForge's task, persona, and artifact contracts.

## Decision gate

The fork's direction is full replacement. Production cutover still requires:

- a released SDK that meets the conformance matrix;
- restart-safe local Podman operation within agreed resource/startup budgets;
- idempotent integration and complete workspace reconstruction;
- acknowledged controls and evidence-bound human approvals;
- a tested upgrade, backup/restore, and cutover/rollback procedure.

If a gate fails, delay retirement and revise the implementation choice rather
than maintaining two engines indefinitely. Treat automatic multi-host failover
and independently scaled activity services as separate hosted acceptance gates.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Infrastructure complexity becomes mandatory | Manage a rootless local stack; make prerequisites and resource costs explicit |
| Duplicate activity delivery repeats side effects | Durable receipts, reconciliation, fenced integration, and provider idempotency where available |
| Remote state diverges from Git workspace state | Persist commit and artifact integrity references and reconstruct from explicit checkpoints |
| Large or sensitive outputs overload workflow state | Store payloads externally and retain bounded references |
| SDK behavior constrains Node implementation | Validate SDK maturity before changing production architecture |
| Dapr Agents duplicates existing abstractions | Defer adoption and require a separate value case |
| Old worker writes after lease expiry | Check fencing tokens at the integration boundary |
| Workflow upgrade breaks history replay | Version definitions/contracts and drain incompatible runs |
| Local containers mistaken for remote durability | Require shared artifacts/checkpoints and a clean-host recovery test |
| Local profile exposes credentials or host control | Narrow mounts, scoped secrets, private service ports, no worker engine socket |
| Podman VM behaves differently on desktop platforms | Separate networking, volume, credential, and performance acceptance tests |

## Documentation impact if implemented

Implementation would require a new ADR plus updates to `ARCHITECTURE.md`,
`docs/workflow-engine.md`, `docs/workflow-engine-deep-dive.md`,
`docs/artifact-store-deep-dive.md`, the workflow-engine `SKILL.md`, launcher and
Console guidance, deployment documentation, and release notes.

For this research-only revision, those documents remain descriptions of the
existing engine: no runtime change, release bump, or accepted implementation ADR
is implied. Record the replacement decision in a new ADR when the spike gates
pass, then update active guidance in the implementation change.

## References

- [Architecture](../../ARCHITECTURE.md)
- [Workflow engine](../workflow-engine.md)
- [Workflow engine deep dive](../workflow-engine-deep-dive.md)
- [Artifact store deep dive](../artifact-store-deep-dive.md)
- [ADR-014: Dynamic workflow orchestration](../adr/014-dynamic-workflow-orchestration.md)
- [ADR-017: Artifact store and context projection](../adr/017-artifact-store-and-context-projection.md)
- [ADR-056: Parallel task execution](../adr/056-parallel-execution-task-sandboxes.md)
- [Dapr SDK support](https://docs.dapr.io/developing-applications/sdks/)
- [JavaScript Workflow authoring](https://docs.dapr.io/developing-applications/sdks/js/js-workflow/)
- [Workflow architecture and scalability](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-architecture/)
- [Workflow concepts and activity delivery](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/)
- [Multi-application Workflow SDK support](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-multi-app/)
- [Supported state stores](https://docs.dapr.io/reference/components-reference/supported-state-stores/)
- [PostgreSQL v2 state component](https://docs.dapr.io/reference/components-reference/supported-state-stores/setup-postgresql-v2/)
- [Dapr Scheduler](https://docs.dapr.io/concepts/dapr-services/scheduler/)
- [Dapr self-hosted with Podman](https://docs.dapr.io/operations/hosting/self-hosted/self-hosted-with-podman/)
- [Podman machine](https://docs.podman.io/en/latest/markdown/podman-machine.1.html)
- [Podman rootless limitations](https://github.com/containers/podman/blob/main/rootless.md)
