# Active Plan: Dapr Engine Replacement

**Created:** 2026-10-13

**Status:** P0-GATE, P1-GATE, and P2-GATE accepted by the operator; P1-06 is
recorded in ADR-066 and the P2 v1 contract is reviewed. P2-03 extraction landed
in [issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4); P2-05
conformance fixtures are implemented in
[issue #5](https://github.com/McFuzzySquirrel/my-forge/issues/5). P3 is
complete and P3-GATE was accepted in
[issue #7](https://github.com/McFuzzySquirrel/my-forge/issues/7). P4-GATE was
accepted by the operator on 2026-10-19, authorizing P5, with deployment/access
decisions recorded in
[ADR-068](docs/adr/068-local-deployment-and-access-profiles.md). P5-01–06 are
done, and P5-GATE was accepted by the operator on 2026-10-21, authorizing P6.
P6 is tracked in [issue #17](https://github.com/McFuzzySquirrel/my-forge/issues/17);
P6-01 through P6-03 are complete ([P6-01 evidence](#p6-01-failure-boundary-evidence--2026-10-21),
[P6-02 evidence](#p6-02-backup-and-restore-evidence--2026-10-21),
[P6-03 evidence](#p6-03-upgrade-and-rollback-evidence--2026-10-21)).
The runtime is not yet a production replacement.

**Direction:** One Dapr Workflow engine, with local Podman and hosted deployment
profiles; no permanent legacy backend

**Design basis:** [Dapr evaluation](docs/research/dapr-workflow-and-agents.md)

## Scope and invariants

Replace scheduling, durable run state, and execution controls. Retain requirements
authoring, manifest compilation, harness portability, verification, typed artifact
projection, and isolated Git workspaces. Do not rewrite these merely to adopt Dapr.

- Requirements remain owned by `docs/PRD.md` and `docs/features/*.md`; manifests
  are immutable execution snapshots, not a second requirements source.
- Dapr owns workflow history. Application receipts, repository ownership, and
  artifact metadata have separately owned schemas.
- All filesystem, Git, CLI, provider, and other nondeterministic operations run
  outside workflow code.
- At-least-once activities must not duplicate accepted artifacts or integration.
  Repeated paid provider calls remain possible without provider idempotency.
- Local operation requires neither Kubernetes nor a cloud account. Offline
  operation additionally requires cached dependencies and a local harness/model.
- Local persistent volumes provide restart recovery, not multi-host failover.
- The old engine is a migration reference until cutover, never a simultaneous
  writer of the same run or target branch.
- Defer Dapr Agents, semantic memory, independent activity applications, automatic
  import of live legacy histories, and containerized target-build infrastructure.

## Tracking rules

Task IDs below are stable implementation work-package IDs, not generated engine
task IDs. All boxes start unchecked. Assign an owner and link an issue/PR before
starting a task; keep detailed execution evidence with that issue/PR.

Mark a task complete only when its deliverable, tests, and applicable documentation
are merged. Mark a phase gate complete only after its acceptance evidence is
reviewed. A blocked gate blocks dependent phases; never check it based solely on
a successful happy-path demonstration.

When converting work into canonical feature contracts, reference these IDs and
link the owning feature documents here. Do not duplicate requirement bodies or
hand-edit generated manifests. Keep this file as the roadmap/status index.

| Phase | Depends on | Accountable role to assign | Status | Issue/PR and acceptance evidence |
|---|---|---|---|---|
| P0 — Baseline and contracts | None | Architecture + QA; agent prepares evidence, operator accepts | Gate accepted; baseline unblocked | [P0 review #2](https://github.com/McFuzzySquirrel/my-forge/issues/2); [P0 evidence](#p0-evidence--2026-10-13); [canonical feature](docs/features/dapr-foundation.md) |
| P1 — Released SDK and runtime spike | P0 gate | Runtime + platform; agent prepares experiment, operator accepts | P1-GATE accepted; P1-06 recorded | [P1 spike #3](https://github.com/McFuzzySquirrel/my-forge/issues/3); [P1 evidence](#p1-spike-evidence--2026-10-13); [ADR-066](docs/adr/066-dapr-workflow-full-replacement-architecture.md) |
| P2 — Reusable execution boundary | P1 gate | Engine + contracts | P2-GATE accepted; P2 deliverables complete | [P2-03 issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4); [P2-05 issue #5](https://github.com/McFuzzySquirrel/my-forge/issues/5); [P2-GATE review #6](https://github.com/McFuzzySquirrel/my-forge/issues/6); [P2 feature](docs/features/dapr-execution-boundary.md); [v1 contract](docs/contracts/dapr-execution-v1.md) |
| P3 — Durable execution and integration | P2 gate | Engine + storage | P3-01–06 implemented; P3-GATE accepted | [P3-GATE review #7](https://github.com/McFuzzySquirrel/my-forge/issues/7); [P3-GATE evidence](#immediate-next-work-package) |
| P4 — Complete local vertical slice | P3 gate | Runtime + platform | P4-01–06 complete; P4-GATE accepted 2026-10-19 | [P4-01 issue #8](https://github.com/McFuzzySquirrel/my-forge/issues/8); [P4-02 issue #9](https://github.com/McFuzzySquirrel/my-forge/issues/9); [P4-02 PR #10](https://github.com/McFuzzySquirrel/my-forge/pull/10); [P4-04 issue #11](https://github.com/McFuzzySquirrel/my-forge/issues/11); [P4-05 issue #13](https://github.com/McFuzzySquirrel/my-forge/issues/13); [P4-GATE evidence](#p4-gate-acceptance-evidence--2026-10-19); [P4-01 live recovery evidence](#p4-01-live-recovery-evidence); [P4-05 execution evidence](#p4-05-representative-execution-evidence); [P4-06 bound evidence](#p4-06-bound-evidence) |
| P5 — Launcher and Console migration | P4 gate | Launcher + Console | P5-01–06 done; P5-GATE accepted 2026-10-21 ([evidence](#p5-gate-evidence--2026-10-22)) | @McFuzzySquirrel |
| P6 — Recovery and release qualification | P5 gate | QA + security + platform | In progress; P6-01–03 done | @McFuzzySquirrel; [P6 issue #17](https://github.com/McFuzzySquirrel/my-forge/issues/17); [P6-01 evidence](#p6-01-failure-boundary-evidence--2026-10-21); [P6-02 evidence](#p6-02-backup-and-restore-evidence--2026-10-21); [P6-03 evidence](#p6-03-upgrade-and-rollback-evidence--2026-10-21) |
| P7 — Cutover and legacy retirement | P6 gate | Release + documentation | Not started | Unassigned |
| P8 — Hosted deployment | P6 gate; public release after P7 | Platform + security | Not started | Unassigned |

P1's spike may contain minimal throwaway/test activities; it is not the production
engine. P3 can develop storage and execution adapters in parallel after P2, but
integration remains serial at the repository mutation boundary. P8 design work
may overlap P7 after local qualification; hosted availability is a separate gate.

## P0 — Establish the baseline and implementation contract

**Deliverables:** behavior inventory, canonical work breakdown, compatibility
matrix, agreed acceptance budgets, and a baseline test record.

- [x] **P0-01 — Inventory execution semantics.** Map DAG/phase dependencies,
  skipped tasks, manual selection and its transitive dependencies, per-owner
  concurrency, retries, timeouts, replay, reconciliation, and task outcome rules
  to current implementation and tests.
- [x] **P0-02 — Inventory callers and state ownership.** Identify launcher,
  Console, bootstrap, auto-build, dashboard, and visualization dependencies on
  state files, audit files, control files, PID signalling, and dynamic imports.
  Record which caller migrates in which task.
- [x] **P0-03 — Establish test baselines.** Run existing engine, execution adapter,
  and launcher tests/typechecks plus launcher build/version checks; record
  environment and results. Separate pre-existing failures from replacement
  regressions without removing unrelated tests.
- [x] **P0-04 — Define compatibility decisions.** Classify each public command,
  flag, environment variable, state field, and lifecycle behavior as preserved,
  deliberately changed, or retired. Explicitly decide auto-commit disabled mode,
  current non-fatal commit failures, dirty repositories, and stop versus pause.
- [x] **P0-05 — Author canonical implementation features.** Register the work in
  the repository's canonical requirements layout, with acceptance criteria and
  dependencies linked to these work-package IDs. Keep unresolved SDK choices as
  decisions rather than assuming an implementation language.
- [x] **P0-06 — Agree measurable budgets and threat boundaries.** Record supported
  host platforms, startup/RAM/disk budgets, recovery targets, retention, artifact
  limits, cancellation deadlines, trusted repository assumptions, and allowed
  harness/validation privileges. Measurements must have explicit pass thresholds
  before qualification.
- [x] **P0-GATE:** Every existing execution/control behavior has an owner and
  compatibility disposition; baseline results and acceptance thresholds are
  recorded; canonical work is validated.

**Starting points:** `templates/skills/forge-workflow-engine/scripts/engine.ts`,
`types.ts`, `state.ts`, `control.ts`, `task-graph.ts`, and corresponding tests;
`scripts/forge-launcher/scripts/engine-run.ts`, `resume.ts`, and `console/`;
`templates/skills/forge-auto-build/SKILL.md`.

## P1 — Prove released SDK support and rootless Podman operation

**Deliverables:** reproducible spike, pinned compatibility matrix, local topology,
and an accepted architecture decision.

- [x] **P1-01 — Verify released capabilities.** Select exact runtime, JavaScript
  Workflow SDK, Node, Podman, state component, and image versions. Check released
  support for workflow registration, activities, durable timers, external events,
  retries, cancellation controls, history replay, and graceful worker shutdown.
  Record official evidence and known limits; default-branch docs are not proof.
- [x] **P1-02 — Resolve SDK/language gate.** Prefer TypeScript and one workflow
  application registering all workflows/activities. If released support is
  insufficient, explicitly approve a supported orchestration language with a
  Node execution boundary or stop and revisit; do not invent a workflow protocol.
- [x] **P1-03 — Stand up the local spike.** Use documented Podman support and
  explicit networking for application/sidecar, Placement, Scheduler, PostgreSQL
  actor state, and separate artifact storage. Persist database, Scheduler/etcd,
  and artifact data; keep infrastructure ports private.
- [x] **P1-04 — Exercise durability.** Run a stub activity, durable timer, and
  approval wait; restart the app/sidecar, then the infrastructure stack. Verify
  the same workflow resumes with preserved history, no volume deletion, and no
  manual edits.
- [x] **P1-05 — Measure and inspect local constraints.** Check rootless volume
  ownership, SELinux, port mapping, resource use, readiness ordering, and signal
  handling. Demonstrate a cached offline stub/local-model path.
- [x] **P1-06 — Record the architecture decision.** Add the next unused ADR after
  checking current numbering. Specify approved versions, persistence, application
  boundaries, rollout scope, and the reasons for full replacement.
- [x] **P1-GATE:** Reproducible Linux rootless restart evidence passes the P0
  budgets; released SDK support is sufficient; language/topology choices are
  accepted. No claim of independent TypeScript activity scaling is required.

**Failure disposition:** stop production replacement work, retain the legacy
engine, and revise the decision. Do not turn the spike into an indefinite second
backend.

## P2 — Define contracts and extract reusable execution components

**Deliverables:** versioned contracts, conformance fixtures, and reusable task
execution without dependence on the old scheduler.

**Canonical contract:** [Dapr execution boundary](docs/features/dapr-execution-boundary.md)
and [Dapr execution contract v1](docs/contracts/dapr-execution-v1.md). P2 work
does not change the production engine; P2-GATE is accepted and P3 is authorized.

- [x] **P2-01 — Define run submission and identity.** Specify repository/branch,
  run, task, logical attempt, operation, and manifest digest identities. Snapshot
  resolved contracts, harness selection, configuration, and definition versions.
  Deduplicate retried submissions and reject incompatible snapshots.
- [x] **P2-02 — Define service/control models.** Specify status queries, task
  selection, pause/resume/stop, cancellation, task replay, approvals, and request
  acknowledgement. Separate requested, accepted, applied, and rejected controls.
  Acknowledgement must not imply a harness process has already stopped.
- [x] **P2-03 — Separate execution utilities.** Reuse harness adapters, request
  construction, task context, output/no-op checks, structured results, validation,
  artifact projection, and workspace utilities through narrow interfaces.
  Preserve existing utility tests and baseline legacy behavior during extraction.
- [x] **P2-04 — Define storage/checkpoint contracts.** Specify immutable artifact
  references/digests, receipt state transitions, repository fencing, checkpoint
  publication, integrity checks, schema versions, and retention. Keep application
  records separate from Dapr internals.
- [x] **P2-05 — Build the conformance matrix.** Turn P0 dispositions into fixtures
  and expected outcomes covering the cases listed in the release matrix below.
  Reuse the current test runner rather than introducing a parallel test framework.
- [x] **P2-06 — Choose package and deployment ownership.** Record where the
  service, reusable execution library, container resources, and launcher client
  live; define bundling/bootstrap responsibilities before scaffolding packages.
  Target repositories should not install a second scheduler accidentally.
- [x] **P2-GATE:** Contracts are reviewed and versioned; extracted utilities
  retain passing tests; all intentional behavior changes have migration notes.

**Starting points:** workflow engine `request.ts`, `task-context.ts`,
`task-execution.ts`, `task-result.ts`, `verify.ts`, `artifacts.ts`, `sandbox.ts`,
`commit.ts`, and `harness/`; execution adapter `scripts/adapter.ts`.

## P3 — Implement durable task effects and fenced integration

**Deliverables:** recoverable execution activities, storage adapters, and one
repository integration authority.

- [x] **P3-01 — Persist operation receipts.** Support claimed, executing,
  effect-published, accepted, and failed/ambiguous outcomes with compare-and-set
  transitions. Redelivery reuses the logical attempt key; deliberate retries and
  task replay allocate new identities. Reconcile incomplete receipts after crashes.
- [x] **P3-02 — Publish artifacts and checkpoints.** Persist content and integrity
  metadata before reporting activity success. Capture base revision, resulting
  changes including new/deleted/binary files, required Git objects, validation
  evidence, and toolchain/dependency metadata. Missing/corrupt objects fail closed.
- [x] **P3-03 — Reconstruct isolated workspaces.** Prepare clean clones/worktrees
  from explicit checkpoints, verify paths and digests, apply the dirty-tree policy,
  and provision dependencies/credentials narrowly. Resume never requires the old
  worker's uncommitted files.
- [x] **P3-04 — Fence repository integration.** Allocate increasing ownership
  tokens per repository/target branch. Enforce the token at the actual mutation
  boundary so expired workers cannot write directly; a pre-write TTL check alone
  is insufficient. Check expected heads, serialize integration, and surface conflicts.
- [x] **P3-05 — Reconcile Git effects.** Detect an already integrated change after
  a crash before receipt persistence; avoid duplicate commits. Preserve audit
  references. Apply P0's explicit no-auto-commit/commit-failure policy without
  marking an uncheckpointed effect recoverable.
- [x] **P3-06 — Enforce process lifecycle and isolation.** Propagate timeout and
  cancellation to owned harness subprocesses, handle worker loss, and reject
  late/stale outcomes. Avoid host-home mounts and engine sockets; document the
  separately approved approach for target builds requiring containers.
- [x] **P3-GATE:** Redelivered activities produce one accepted effect set;
  stale owners cannot mutate the target branch; checkpoints reconstruct a task
  workspace; ambiguous integration is visible and blocks unsafe continuation.

## P4 — Complete the local Dapr workflow vertical slice

**Deliverables:** the replacement DAG workflow, durable controls, and a real
local task chain running through the same contracts as the old engine.

- [x] **P4-01 — Implement deterministic orchestration.** Evaluate snapshot task
  readiness, phase dependencies, selected scope, skipped tasks, owner exclusivity,
  and bounded execution. Use durable timers/events for retry delays and waits;
  keep I/O, random identities, and wall-clock decisions in activities or approved
  deterministic runtime facilities.
- [x] **P4-02 — Integrate verification and handoffs** ([issue #9](https://github.com/McFuzzySquirrel/my-forge/issues/9); [PR #10](https://github.com/McFuzzySquirrel/my-forge/pull/10)). A successful harness exit
  is insufficient: require expected outputs, no-op policy, structured outcomes,
  mandatory validation, and compact predecessor artifacts before accepting work.
- [x] **P4-03 — Implement durable controls and approvals.** Deduplicate requests,
  authorize operators, bind approvals to run/task and manifest/evidence digests,
  and reject stale attestations. Honor the agreed pause/stop/cancel distinctions.
- [x] **P4-04 — Expose status and audit**
  ([issue #11](https://github.com/McFuzzySquirrel/my-forge/issues/11); owner:
  operator). Provide authoritative run/task/attempt queries, sequenced lifecycle
  records, and reconnectable notifications. Compatibility file exports are
  read-only, rebuildable views, never control input.
- [x] **P4-05 — Prove representative execution**
  ([issue #13](https://github.com/McFuzzySquirrel/my-forge/issues/13)). Complete a stub dependency chain,
  verification failure/retry, manual selection, parallel isolated tasks, and an
  approval wait. Then execute one real harness using scoped credentials and
  inspect integrated changes and validation evidence.
- [x] **P4-06 — Bound histories and concurrency.** Measure large manifests,
  long waits, retry storms, and artifact/reference limits. Decide history rollover
  or child-workflow strategies only where supported, preserving task identity and
  evidence; apply backpressure and configurable worker limits. See
  [ADR-067](docs/adr/067-bounded-workflow-histories-and-concurrency.md) and the
  [P4-06 bound evidence](#p4-06-bound-evidence).
- [ ] **P4-GATE:** Representative manifests meet the conformance matrix locally
  and resume after interruption without manual state edits.

## P5 — Migrate the launcher, Console, and local lifecycle

**Deliverables:** one service-backed user path and a managed local deployment.

**P5 deployment and access decisions** ([ADR-068](docs/adr/068-local-deployment-and-access-profiles.md),
[feature](docs/features/dapr-local-deployment-access.md)): P5 ships the
single-user *local* profile; the *shared* collaborator profile is designed now
and implemented only under P8. Standalone use with no collaborators, shared
server, or GitHub App is a first-class path.

- [x] **P5-01 — Package the local stack** (completed 2026-10-19; owner:
  @McFuzzySquirrel; [issue #16](https://github.com/McFuzzySquirrel/my-forge/issues/16)).
  Supply pinned images/configuration,
  persistent-volume ownership, readiness checks, restart policy, and resource
  limits. A container recreation must not reset durable data. Ship a persistent
  launcher-distributed Podman Compose stack (PostgreSQL, Dapr sidecar,
  Placement, Scheduler) with separate named volumes. PostgreSQL is private by
  default; an optional host-tools override publishes only
  `127.0.0.1:${POSTGRES_PORT:-55432}:5432` and reports a port conflict rather
  than choosing another port. Containers use service DNS, not the host port.
  `tools/dapr-engine/compose.postgres.yaml` stays the separate test database
  with its own volume.
- [x] **P5-02 — Add lifecycle management.** The launcher manages the Forge
  service and PostgreSQL/Dapr stack with `runtime start/status/stop/reset`;
  readiness includes a Dapr workflow-admission probe, unhealthy containers
  include credential-redacted log diagnostics, stop preserves volumes, and
  reset requires `--confirm`. `runtime backup --output` quiesces the stack and
  exports checksummed PostgreSQL, Scheduler, and Forge runtime/artifact volume
  archives; `runtime restore --from ... --confirm` verifies and replaces those
  volumes before restarting and reproving readiness. Append-only SQL migrations
  fail closed on checksum drift, version gaps, and databases newer than the
  installed service. `runtime start` applies compatible migrations after a
  launcher update; schema downgrade and cross-version workflow-history
  compatibility are not promised. The backup does not include target Git
  repositories or their working trees/refs; repository backup remains separate
  until those paths are service-managed.
- [x] **P5-03 — Migrate execution entry points.** Update engine-run, resume,
  launcher flow, wrappers, bootstrap/package resources, and auto-build polling
  to submit/query/control the service. Select local versus hosted deployment,
  not legacy versus Dapr scheduling.
  *In progress* ([ADR-069](docs/adr/069-service-run-submission-and-repository-binding.md)):
  the worker serves a loopback, token-authenticated run API with durable,
  idempotent submissions, restart rebinding, events, and pause/resume/stop/
  cancel/replay/approve controls. `runtime repo add` mounts only registered
  `.git` directories; `service submit|runs|status|events|control|merge` runs
  on `forge/<base>` branches and fast-forwards the checked-out branch on
  request. Terminal runs release repository leases. Live stub-harness runs,
  replay, idempotent resubmission, and restart rebinding were validated.
  *Done* ([ADR-071](docs/adr/071-service-harnesses-and-execution-entry-points.md)):
  - The worker image pins the `copilot`, `claude`, and `opencode` CLIs.
  - `runtime harness grant|list|revoke` manages owner-only, per-harness
    allowlisted credentials, re-read for each attempt. Ungranted harnesses
    are rejected at submission.
  - For registered repositories, engine-run, resume, feature-increment
    runs, and auto-build use the service: they submit, attach, or resume,
    follow events, and fast-forward on completion. Unregistered
    repositories keep the legacy engine until P7.
  - `FORGE_DEPLOYMENT` selects local versus hosted; hosted fails until P8.
  - Human-review tasks wait on published review evidence without a harness.
  - Wrappers delegate to `engine-run`, and `stage-resources.mjs` already
    stages the deploy resources.
- [x] **P5-04 — Migrate Console/Board controls.** Replace file/PID control with
  authenticated service requests and acknowledged outcomes; reconnect from
  sequenced status/events. Remove scheduling dependence on dynamically importing
  the legacy engine while retaining shared readiness semantics.
  *In progress:* the Console **Service runs** view monitors service runs from
  sequenced events and sends authenticated pause/resume/stop/cancel/approve/
  replay requests through the Console server, showing the service's
  acknowledgement (live approve validated).
  *Done:* for registered repositories:
  - Overview builds run through the service.
  - Pause, Stop, Replay, and human-review approval go to the repository's
    service run. A Console review approval also writes the reviewer's notes,
    with the run and control IDs, to `docs/reviews/`.
  - The Overview shows the execution deployment.

  The Console still imports the shared readiness logic to project task
  status. File/PID control remains only for unregistered repositories until
  P7 retires the legacy engine.
- [x] **P5-05 — Harden local access.** Expose Forge API/Console only on loopback
  by default; authenticate controls, validate browser origins/CSRF protections,
  constrain repository paths, scope secrets, and redact logs. Sidecar/store APIs
  remain private and inaccessible to untrusted task processes where feasible.
  Local access uses a protected local operator session that trusts the OS user:
  a one-time bootstrap capability is exchanged for an expiring browser session.
  No GitHub, `gh`, Copilot, or GitHub App login is required, and authentication
  is independent of the selected harness. Non-loopback binding fails unless a
  qualified shared profile is configured.
  *Done* ([ADR-070](docs/adr/070-local-operator-session-and-sidecar-token.md)):
  the Console requires a session for every route, obtained by exchanging a
  single-use, 10-minute terminal sign-in capability for an `HttpOnly`,
  `SameSite=Strict`, port-scoped cookie with a 12-hour idle timeout; it checks
  `Host`/`Origin`, keeps `X-Forge-Token` on `POST`, removes `/api/token`, and
  adds Sign out. The runtime adds `DAPR_API_TOKEN`, which Compose requires for
  `daprd` and the worker; `runtime rotate-tokens` rotates it with the API
  token. `DAPR_*`/`MYFORGE_*` variables never reach harnesses, and a deployment
  test pins published ports to loopback. A live stub-harness run waiting for
  approval survived `runtime stop`/`start`, was approved through
  `service control`, and completed; rotated tokens rejected the old token.
- [x] **P5-06 — Preserve diagnostics and onboarding.** Show useful errors for
  unavailable Podman, missing VM/resources, credentials, corrupt volumes, and
  version mismatches. Export compatible status/audit views and document offline
  preparation, migration warnings, and disabled/retired flags.
  *Done:* runtime commands give install, Podman machine, rootless, and
  compose-provider guidance, and failures add `Hint:` lines for disk/memory
  limits, port conflicts, image pulls, credential mismatches, corrupt volumes,
  schema history, and version mismatches. A 401 explains how to apply rotated
  tokens. `service runs|status|events --json` export run records and the full
  event audit trail. [Runtime troubleshooting](docs/forge-launcher.md#runtime-troubleshooting)
  documents remedies, upgrades, offline use, and disabled/retired options.
- [x] **P5-GATE:** A fresh local user can start the stack, submit and monitor a
  run, approve/control it, stop/restart, and recover through launcher and Console
  without editing generated files or using infrastructure APIs.
  *Accepted by the operator on 2026-10-21:* see
  [P5-GATE evidence](#p5-gate-evidence--2026-10-22).

**Starting points:** `scripts/forge-launcher/scripts/engine-run.ts`, `resume.ts`,
`bootstrap.ts`, `launcher.ts`, `stage-resources.mjs`, and
`console/{control,jobs,paths,repo,server}.ts`; workflow-engine and auto-build skills.

## P6 — Qualify recovery, security, upgrades, and platforms

**Deliverables:** automated failure-injection coverage, operational runbooks,
support matrix, and release evidence.

- [x] **P6-01 — Exercise failure boundaries.** Kill application/sidecar/worker
  during execution, retry delay, approval wait, checkpoint publication,
  integration, and receipt persistence. Duplicate deliveries/controls; expire
  ownership, introduce store outages, and deliver late task results.
- [x] **P6-02 — Test backup and restore.** Quiesce or otherwise coordinate snapshots
  of workflow database, application receipts, Scheduler, artifacts, and Git refs.
  Restore into a fresh installation and check integrity and pending timers.
  Missing/out-of-sync stores must not silently accept incomplete tasks.
- [x] **P6-03 — Test workflow/application upgrades.** Version definitions and
  activity contracts; drain incompatible runs or retain compatible workers.
  Verify historical replay, schema upgrades, and documented rollback constraints.
- [x] **P6-04 — Review security boundaries.** Test unauthorized/stale approvals,
  cross-repository access, escaping paths/symlinks, log/secret exposure, malicious
  artifact metadata, and exhausted resource limits. Scan dependencies and changed
  code; require resolution of relevant findings before cutover.
  *Done 2026-10-21 ([ADR-075](docs/adr/075-security-boundary-review.md)):
  audit clean; validation-command secret exposure fixed; live API probes pass.
  **Open cutover blocker:** harness processes run as container root beside
  every repository's read-write `.git` and the grants file. A dedicated
  task UID is required.*
- [ ] **P6-05 — Qualify supported platforms/harnesses.** Validate Linux rootless
  behavior and each claimed harness. Test Podman-machine networking, credentials,
  mounts, path translation, watchers, and performance separately on macOS/Windows.
  Preserve Linux, macOS, and Windows support; missing desktop evidence is a
  qualification gap, not permission to drop platform support.
  *Partial 2026-10-21 ([P6-05 evidence](#p6-05-platform-and-harness-evidence--2026-10-21)):
  Linux rootless evidence recorded. macOS/Windows Podman-machine qualification
  and real-harness runs remain required. Harness selection must not require
  additional GitHub repository credentials; reuse existing authorized provider
  authentication where possible without exposing unrelated credentials.*
- [x] **P6-06 — Re-run parity and budgets.** Compare accepted outcomes, commit
  behavior, validation, audit, and controls with P0 fixtures; measure startup,
  memory/disk, long histories, cancellation, and recovery against agreed thresholds.
  *Done 2026-10-21 ([P6-06 evidence](#p6-06-parity-and-budget-evidence--2026-10-21)):
  all budgets met; cancellation has little headroom.*
- [ ] **P6-GATE:** Release matrix below passes for every advertised profile;
  backup/restore and upgrades are rehearsed; support limits and unavoidable
  duplicate provider calls are documented. Unqualified platforms are not advertised.

## P7 — Cut over and retire the legacy scheduler

**Deliverables:** sole-engine release, migrated guidance, and reversible cutover.

- [ ] **P7-01 — Rehearse migration.** Back up legacy state, artifacts, and Git;
  stop new legacy runs and drain active ones. Validate completed checkpoints
  before creating Dapr runs. Block unsupported partial-history imports.
- [ ] **P7-02 — Rehearse rollback.** Use a previous release plus pre-cutover backup;
  explicitly stop Dapr writers before restoring legacy ownership. Do not feed
  Dapr history into the file engine or silently discard post-cutover Git changes.
  Document how to preserve/reconcile those changes.
- [ ] **P7-03 — Switch the default execution path.** Make Dapr mandatory for new
  runs in this fork after qualification; retain archived evidence, not a permanent
  backend switch. Fail clearly if infrastructure is unavailable.
- [ ] **P7-04 — Remove legacy writers and stale callers.** Retire the old DAG
  loop, writable file control/state path, PID-based execution controls, and legacy
  polling after P0's caller inventory is fully migrated. Preserve reusable modules
  and move relevant semantic tests to their replacement owners.
- [ ] **P7-05 — Publish migration/release documentation.** Update architecture,
  workflow/engine deep dives, artifact guidance, launcher/package README, Console
  guides, relevant skills, testing guidance, and deployment runbooks. Add release
  notes and synchronize README Latest. Preserve historical ADRs/changelog entries.
- [ ] **P7-GATE:** Fresh and migrated repositories use only Dapr orchestration;
  no supported caller writes legacy authority; cutover/rollback is rehearsed and
  all advertised behavior matches active documentation.

## P8 — Productize hosted recovery as a separate deployment profile

**Deliverables:** shared-storage deployment, clean-host recovery evidence, and
authenticated operations without changing task semantics.

- [ ] **P8-01 — Provision shared persistence.** Replace local-only artifact volumes
  with a shared object-store adapter and recoverable Git checkpoints; provide
  appropriate database, Scheduler, and Placement availability and coordinated
  backups. Shared workflow state alone is insufficient.
- [ ] **P8-02 — Isolate workers and users.** Scope repository credentials,
  authorize run/approval operations, separate trust domains, protect internal
  Dapr services, and enforce compute/storage quotas. Same-app replicas register
  compatible workflow/activity definitions. Shared deployments authenticate
  collaborators through GitHub App user sign-in, not an ambient browser, `gh`,
  or harness login. Authorization requires both the app installation on the
  repository and the user's current permission: read/triage may view;
  write/maintain/admin may run, control, and approve. Host administration is
  configured separately. App ownership is decided in P8 (initial proposal:
  operator-registered per deployment).
- [ ] **P8-03 — Prove clean-host failover.** Lose a worker and recreate its execution
  solely from shared stores and Git on another host, including credentials and
  dependencies. Simulate partitions and prove stale workers cannot integrate.
- [ ] **P8-04 — Operate the service.** Add health/readiness, traces, queue/attempt
  metrics, alerts, retention/garbage collection, disaster recovery, and rolling
  upgrade procedures. Do not collect sensitive prompt content by default.
- [ ] **P8-05 — Gate independent activity scaling.** Recheck released SDK
  multi-application support. Adopt separate activity applications only with a new
  decision and conformance evidence; same-app scaling is a valid initial outcome.
- [ ] **P8-GATE:** Hosted recovery and isolation meet their agreed budgets and
  security criteria; hosted/local run outcomes remain equivalent. Do not label
  a single-node persistent deployment highly available.

## Release acceptance matrix

Each row requires linked test results before P6/P7; hosted rows additionally gate
P8. A passing row does not replace its phase's other acceptance requirements.

| Area | Required evidence |
|---|---|
| Scheduling | Phase/task dependencies, skipped tasks, manual transitive scope, owner exclusivity, bounded parallelism |
| Outcomes | Missing outputs, no-op detection, structured-result failures, mandatory validation, artifact projection |
| Retries | Exhaustion, durable delay, restart during wait, redelivery versus explicit retry identity |
| Controls | Authenticated acknowledgements, graceful pause/stop, resume, cancellation process cleanup, late-result rejection |
| Human review | Prerequisite gating, immutable evidence binding, unauthorized/stale/duplicate event rejection |
| Git | Expected-head conflicts, one integration per logical attempt, stale-owner fencing, disabled/failed auto-commit policy |
| Recovery | Restart app and stack, clean checkpoint reconstruction, crashes before/after each effect receipt |
| Operations | Consistent backup/restore, compatible history replay, rollback, bounded resource/retention behavior |
| Clients | Launcher/Console reconnection, read-only exports, migrated bootstrap and auto-build callers |
| Platforms | Real Linux rootless run; separate macOS/Windows evidence only if supported |
| Hosted | Shared objects, clean-host failover, partitions/fencing, scoped identities and quotas |

## Verification and documentation discipline

Use existing package commands for affected code. Current entry points are
`npm test` and `npm run typecheck` in each of:

- `/home/runner/work/my-forge/my-forge/templates/skills/forge-workflow-engine`
- `/home/runner/work/my-forge/my-forge/templates/skills/forge-execution-adapter`
- `/home/runner/work/my-forge/my-forge/scripts/forge-launcher`

The launcher also exposes `npm run build` and `npm run check:version`.
See [testing guidance](docs/testing-guide.md) for other affected package checks.
Add future integration/failure tests to the owning package's normal test workflow,
with explicit infrastructure prerequisites; do not report skipped integration
tests as recovery evidence. Future packages must document their actual commands
when introduced, rather than implying they exist today.

Consult the [documentation map](docs/documentation-map.md) on each behavior change.
Update active instructions with implementation, scan new dependencies and changed
files, and review security-sensitive boundaries before merging. Roadmap status
does not itself imply phase-gate acceptance or production cutover.

## Immediate next work package

P3-GATE was accepted by the operator in [issue #7](https://github.com/McFuzzySquirrel/my-forge/issues/7)
on 2026-10-14; P4 is authorized. **P4-01 — Implement deterministic
orchestration** is complete; its local Dapr timer/event recovery evidence is
recorded below. [P4-01 issue #8](https://github.com/McFuzzySquirrel/my-forge/issues/8)
is complete. **P4-02 — Integrate verification and handoffs** is complete under
[issue #9](https://github.com/McFuzzySquirrel/my-forge/issues/9) and
[PR #10](https://github.com/McFuzzySquirrel/my-forge/pull/10).
P4-03 is complete at the reusable engine boundary: control requests are
durable and idempotent, approval wake events are validated and applied through
the registered resume activity, and run workflows handle pause/resume,
graceful stop, cancellation, and replay at safe boundaries. Hosts must provide
an authenticated trusted-principal adapter, authoritative run context, and
idempotent process/control effects; this repository does not yet contain a
network identity provider or production service host.
**P4-04 is complete under issue #11 (owner: operator):** a transactional
PostgreSQL run/task/attempt status projection, sequenced idempotent lifecycle
events, cursor replay/watch APIs, and workflow status-event activities. The live
PostgreSQL integration suite (15 tests, including run status) passes against a
disposable PostgreSQL container.
**P4-05 is complete under [issue #13](https://github.com/McFuzzySquirrel/my-forge/issues/13):**
representative stub and real Copilot CLI execution passed on a live local Dapr
stack; see [P4-05 representative execution evidence](#p4-05-representative-execution-evidence).
**P4-06 is complete:** explicit run limits, `continueAsNew` history rollover,
outcome and artifact bounds, and run admission backpressure; see
[P4-06 bound evidence](#p4-06-bound-evidence) and
[ADR-067](docs/adr/067-bounded-workflow-histories-and-concurrency.md).
**P4-GATE was accepted by the operator on 2026-10-19**, authorizing P5. The
next work package is **P5-01 — Package the local stack**, tracked in
[issue #16](https://github.com/McFuzzySquirrel/my-forge/issues/16) (owner:
@McFuzzySquirrel).
P5-01 was completed on 2026-10-19. Live rootless Podman validation covered
readiness (every service running and PostgreSQL accepting connections) and
separate least-privilege databases. It also covered Dapr-backed state across
full stack recreation and private internal ports, an alternate loopback
`--postgres-port`, a private restart after host-tools mode, stop preserving
volumes, and confirmed reset removing them. An occupied host port is rejected
before credentials or containers are created. Launcher staging and package
contents, protected credential creation and reuse, and required-credential
failures are tested. The flaky C26 durable-cancel fixture was fixed, and the
full engine suite passes repeatedly. P5-02 provides the worker entry point,
lifecycle, diagnostics, migration checks, and checksummed backups of
service-owned volumes. P5-03 added the service run API, repository binding,
and the `service` launcher commands, then completed by provisioning pinned
harness CLIs with granted credentials and routing engine-run, resume, and
Console builds for registered repositories through the service (ADR-071).
P5-05 hardened local access with a Console operator session and a Dapr
sidecar token (ADR-070). P5-06 added runtime remediation hints, JSON
status/audit export, and troubleshooting docs. P5-04 routes Console controls
and human-review approval to service runs. **P5-GATE was accepted by the
operator on 2026-10-21, authorizing P6**
([P5-GATE evidence](#p5-gate-evidence--2026-10-22)). P6-01 through P6-04 are
complete ([P6-01 evidence](#p6-01-failure-boundary-evidence--2026-10-21),
[P6-02 evidence](#p6-02-backup-and-restore-evidence--2026-10-21),
[P6-03 evidence](#p6-03-upgrade-and-rollback-evidence--2026-10-21),
[ADR-075](docs/adr/075-security-boundary-review.md), which records one open
cutover blocker); P6-05 remains incomplete ([P6-05 evidence](#p6-05-platform-and-harness-evidence--2026-10-21)): Linux, macOS, and Windows remain required support targets. P6-06 budget evidence is recorded ([P6-06 evidence](#p6-06-parity-and-budget-evidence--2026-10-21)). P6-GATE remains blocked by the ADR-075 task-UID finding, real-harness qualification, and macOS/Windows runtime qualification.
P1-06 is recorded in
[ADR-066](docs/adr/066-dapr-workflow-full-replacement-architecture.md). The
P2-01, P2-02, P2-04, and P2-06 contract deliverables are authored. P2-03 landed
in [issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4). P2-05 is
tracked in [issue #5](https://github.com/McFuzzySquirrel/my-forge/issues/5):
cases C01–C25 in [contract v1 §5](docs/contracts/dapr-execution-v1.md#5-conformance-matrix)
run through `npm test --prefix tools/dapr-engine` against an in-memory
reference model. The operator ran the review commands and accepted P2-GATE in
[issue #6](https://github.com/McFuzzySquirrel/my-forge/issues/6) on 2026-10-13.
P3-04 is implemented in
`tools/dapr-engine/storage/postgres/repository-integration.ts` with a PostgreSQL
fence migration. Lease grants and integrations serialize on the same row lock;
the authority holds it across Git's atomic expected-head ref update and the
durable integration record. Stale/expired owners, head conflicts, and
conflicting logical attempts reject; failures after a successful Git update
or an indeterminate Git result surface as ambiguous for reconciliation. The
engine typecheck/unit suite and live PostgreSQL tests passed, including
lock-contention and ambiguous-outcome checks.

P3-05 adds durable integration intents written before any Git mutation,
checkpoint-bound commits (first parent is the expected head, tree is the verified
checkpoint tree), already-integrated detection on redelivery, and
`reconcile()`/`reconcileIntegrationReceipt` so a crash after the ref update is
accepted once without a second commit, an attempt that never integrated fails
and is fenced, and a missing checkpoint stays ambiguous. `resolveGitEffectPolicy`
encodes the P0 auto-commit register. Fixtures C23–C25 and the live PostgreSQL
tests pass.

P3-06 adds durable execution ownership (`forge_operation_executions`): each
executing receipt has one owner epoch with a heartbeat and a deadline fixed by
the first start. Redelivery takes over only after the heartbeat expires and keeps
the original deadline; stale epochs cannot heartbeat, report exit, or publish.
`superviseExecution` turns deadline, durable cancel, and lost ownership into
process-group termination and records exit only after the harness settles;
outcome admission and the receipt transition commit together, rejecting
results before exit, after cancel, or with unconfirmed cleanup. A
process-group watchdog kills a harness tree when its worker dies or stops
responding past the hard deadline, including on a bare host. Isolated
harnesses get a private home and an allowlisted environment without engine
sockets or service credentials, and container specs with host-home or engine
socket binds are rejected. Target builds that need containers require a
separately approved dedicated builder (contract §3). Fixtures C26–C29 and the
live PostgreSQL tests pass.

**P3-GATE accepted.** The gate audit found and fixed two gaps:

- While an earlier attempt's integration was pending or ambiguous, another
  attempt could advance the same branch. `integrate` now returns
  `unresolved-integration` until reconciliation resolves the earlier attempt,
  and a blocked reconciliation records nothing (fixture C30).
- No production code captured a task checkpoint. `captureWorkspaceCheckpoint`
  now does this.

A composed live test (`tests/storage/p3-gate.integration.test.ts`) chains
capture, the integration authority, the execution supervisor, worker-loss
fencing, and checkpoint reconstruction against PostgreSQL and a real Git
repository. A negative control without the unresolved-integration check fails
it.

The operator reviewed the evidence and accepted P3-GATE in issue #7. The
conformance fixtures remain semantic evidence only, not proof of full durable
Dapr effects. The evidence also does not cover Dapr PostgreSQL state, deployment
volumes, or a running service. P4 execution is now authorized; Console migration
and legacy-engine retirement remain gated by their later phases.

### P6-01 failure-boundary evidence — 2026-10-21

**Harness.** `tools/runtime-qualification` (`npm run -s qualify -- failures`)
drives the source launcher against an isolated Compose project
(`MYFORGE_RUNTIME_PROJECT=myforge-qual`, `MYFORGE_RUNTIME_DIR=/tmp/myforge-qual/runtime`,
API port 18483) on rootless Podman 4.9.3, podman-compose 1.0.6, Dapr 1.18.7,
and worker image `localhost/myforge-worker:2`. Each scenario uses its own
fixture repository and stub-harness tasks, and asserts the final run status
and the number of commits per task on the target branch. The operator's
`myforge-runtime` installation was not touched. Three consecutive full runs
after the fixes passed all 10 scenarios (times are the range across the last
two runs).

| ID | Boundary | Result |
|---|---|---|
| F01 | Duplicate submission key reused; changed snapshot under the same key rejected (409) | Pass; one commit |
| F02 | Worker killed during execution, held down past the 30 s ownership TTL | Pass; recovered in 86 s; attempt 2 integrated once |
| F03 | Dapr sidecar killed during execution | Pass; recovered in 84–99 s |
| F04 | Worker and sidecar killed together | Pass; recovered in 51–52 s |
| F05 | PostgreSQL (workflow and application store) outage during execution | Pass; recovered in 37 s; no extra attempt |
| F06 | Full stack stop/start during a 60 s durable retry delay | Pass; restart 20 s; timer fired at 60 s |
| F07 | Approval wait across worker and sidecar loss; approval of a non-waiting task (409), forged evidence (422), duplicate approval (reused), stale approval after completion (422) | Pass |
| F08 | Cancellation during execution, duplicate cancel, late task result with retries enabled | Pass; terminal in 27 s; no commits; after `run.cancelled` only the stopped attempt's own `run-cancelled` failure may be recorded |
| F09 | Duplicate pause/resume controls | Pass; acknowledged once; run completes |
| F10 | Repeated worker kills across a four-task chain | Pass; each task integrated exactly once |

Boundaries that cannot be timed reliably from outside the worker are covered
by deterministic tests: crash after the Git ref update but before the receipt,
pending/ambiguous earlier integrations, stale owner heartbeat/publish after
takeover, and checkpoint reconstruction (`p3-gate.integration.test.ts`,
conformance C23–C30, ownership PostgreSQL tests), plus the P4-01 live timer
recovery evidence.

**Defects found and fixed** ([ADR-072](docs/adr/072-runtime-failure-recovery-and-qualification.md)):

1. Dapr SDK 3.18 never reconnects the workflow worker after an established
   stream drops; the service stayed "ready" without a worker. A watchdog now
   waits for the sidecar and PostgreSQL, then exits so the restart policy
   starts a fresh worker. (Podman skips the restart if a `--requires`
   dependency is down at exit.)
2. A PostgreSQL restart crashed the service with an unhandled pool `error`
   event. Pool and client errors are now logged.
3. A cancel-stopped attempt was retryable, and child task workflows kept
   running after `run.cancelled`; a retry integrated a commit about 65 s after
   cancellation. Cancel stops, and any failure recorded while the run is
   `cancelling`/`cancelled`, are now non-retryable. The execution host refuses
   to start an attempt or begin an integration once the run is cancelling
   (`run-cancelled`).
4. A late `task.failed` racing `task.cancelled` was rejected by the projection
   (`failed -> cancelled`), failing the run orchestration and leaving the run in
   `cancelling`. Cancellation now supersedes a racing failure in either order;
   later task events are kept for audit without reopening the cancelled task.
5. A failed or terminated run orchestration left its run non-terminal forever.
   The service now reconciles these runs to `failed` at startup and every 60 s;
   the stuck run from finding 4 was repaired by this sweep on restart.

**Automated checks.** Engine typecheck and `npm test` pass (178 tests,
including the PostgreSQL integration tests with new cancel-race and
execution-host cancellation regressions; both execution-host regressions fail
with their guard removed). Launcher typecheck and tests pass (348 tests,
including the runtime project/directory overrides).

**Residual risks.**
- An attempt that passed the cancellation check can still integrate if
  cancellation arrives during the integration itself; validation commands are
  not under cancel supervision.
- Worker-loss recovery depends on the container restart policy. If a dependency
  stays down for more than 10 minutes, the service keeps running without a
  worker (logged) until it is restarted.
- Recovery after sidecar loss (up to 99 s) is within the 120 s budget but has little
  headroom; P6-06 re-measures it.
- The run workflow does not terminate child task workflows on cancellation;
  enforcement is at the activity boundary to keep existing histories
  replayable.

### P6-02 backup and restore evidence — 2026-10-21

**Harness.** `npm run -s qualify -- backup` builds pending durable state on the
isolated source installation (`myforge-qual`). It then restores that state into
a fresh second installation (`myforge-qual2`, API port 18484, data under
`/tmp/myforge-qual2`) and checks damaged archives and Git/store drift there.
The environment is the same as for P6-01. The operator's `myforge-runtime`
installation was not touched.

| ID | Scenario | Result |
|---|---|---|
| B01 | Back up the source with a pending 240 s retry timer and an approval wait. Stop the source, register its 68 repositories in a fresh installation, and restore. | Pass. Backup took 21 s; restore to ready took 20 s. Restore with the fresh installation's own credentials was refused, and the installation kept running. After copying `runtime.env`, the approval wait survived and completed. The timer fired at 240.0 s. Each task was committed exactly once. |
| B02 | Restore a tampered volume archive, a backup missing a volume, and a backup missing its manifest | Pass. All three were rejected before any volume was touched; the restored runs were intact. |
| B03 | Git behind the stores: after T1 is accepted, back up, then move `forge/main` back before T1 | Pass. Restore was refused as drift. With `--allow-git-drift`, T2 failed with `integration-history-missing`, the run ended `failed`, and the branch was unchanged. |
| B04 | Git ahead of the stores: back up while T1 runs, then let T1 integrate | Pass. Restore was refused with a reset hint for the recorded tip. After that reset, the restore re-ran T1, and T1 was committed exactly once. |

**Changes** ([ADR-073](docs/adr/073-coordinated-runtime-backup-and-git-consistency.md)):

- Backups record each registered repository's `refs/heads/forge/*` tips and a
  database credential fingerprint while the stack is quiesced.
- Restore verifies the archive, the credentials, and the tips before replacing
  any volume. It refuses drift unless `--allow-git-drift` is passed.
- The integration authority refuses to build on a branch that lost the
  current run's accepted commits. It returns `integration-history-missing`,
  which the execution host makes non-retryable.

Before this change, B03 would have completed the run without T1's accepted
work.

**Automated checks.** Engine typecheck and `npm test` pass (179 tests,
including the new PostgreSQL history-guard test). Launcher typecheck and tests
pass (349 tests, including restore verification of integrity, credentials,
registration, and drift).

**Residual risks.**

- With `--allow-git-drift` and Git ahead of the stores, a restored run can
  integrate a task a second time.
- Target repositories and working trees are not backed up. Operators keep
  forge branches consistent with runtime backups.
- Completed runs are not re-verified against Git after a restore.

### P6-03 upgrade and rollback evidence — 2026-10-21

Design: [ADR-074](docs/adr/074-workflow-definition-versioning-and-upgrade-qualification.md).

**Versioning and drain policy.**
- Each run records `definition_version` (migration 7), and startup refuses
  non-terminal runs with an unsupported version.
- A compatible change keeps the version. An incompatible change registers new
  workflow names and keeps the earlier ones registered until their runs drain.
- Activity payloads keep `schemaVersion: 1`.
- `tests/storage/postgres-definition-versions.integration.test.ts` covers the
  stamping and the gate, including recovery once runs reach a terminal state.

**Historical replay.**
- `capture-histories` exported 126 terminal histories from the qualification
  stacks.
- Replaying all of them against the current code: 125 reached their recorded
  completion. The one exception was a B04 run restored with
  `--allow-git-drift`; its action IDs have a gap (completion is event 4, and
  scheduled action 3 is missing). That restore-time artifact is not a
  workflow non-determinism, and capture now skips such histories.
- Six representative histories are committed under
  `tools/dapr-engine/tests/orchestration/fixtures/histories/`. They cover both
  workflows, the retry timer, task-control and run-control events, activity
  failure, and completed and failed runs.
- `history-replay.test.ts` replays them on every `npm test`. A negative control
  (one inserted activity) fails with `NonDeterminismError`.
- Engine suite: 188 pass with PostgreSQL.

**Live upgrade and rollback** (`npm run -s qualify -- upgrade`):
- The previous release is `8be6cb0`, the P6-02 release, run from a git worktree.
- Runs 1 and 2 were identical: U01 passed in 115 s and U02 in 226 s.

| Scenario | Result |
|---|---|
| U01 in-place upgrade with an approval wait and a 90 s retry timer pending | Schema 6 → 7 applied. Stop plus start under the new release took 20 s. Existing runs read `definition_version` 1. The approval resumed: T1/T2 one commit each. The timer fired and the retry committed T1 once. A run submitted after the upgrade completed with definition 1. |
| U02 rollback | Under the previous release, `runtime start` was refused with "Database schema version 7 is newer than this Forge service supports (6)". Restoring the pre-upgrade backup with the previous launcher took 20 s and brought back schema 6. The approval wait resumed and completed with T1/T2 committed exactly once. |

**Rollback constraint (documented in
[forge-launcher](docs/forge-launcher.md#upgrading)).** The schema is never
migrated back. Rolling back means restoring a backup taken with the earlier
release, and work done after that backup is lost. The ADR-073 drift checks
refuse the restore if Git moved since the backup, unless `--allow-git-drift` is
passed.

### P6-06 parity and budget evidence — 2026-10-21

**Parity.** All suites passed on the release commit:

| Suite | Result |
|---|---|
| `tools/dapr-engine` (contract v1 conformance, orchestration, history replay, PostgreSQL integration) | 188/188 |
| `forge-workflow-engine` (legacy P0 semantics through the shared execution library) | 283 pass, 7 skipped, 0 fail |
| `forge-execution-adapter` | 49/49 |
| `forge-launcher` | 349/349 |

The suites cover accepted outcomes, commit integration, validation gates, audit,
and controls. Recorded histories replay against the current code: 125 of 126
live histories replayed. The one exception was a restore artifact created
deliberately with `--allow-git-drift`.

**Budgets** (measured on Linux rootless, operator-accepted thresholds from
2026-10-13):

| Budget | Threshold | Measured | Result |
|---|---|---|---|
| Cached startup readiness | ≤ 180 s | 14 s (`runtime start`, `myforge-qual2`) | Pass |
| Idle stack memory | ≤ 3 GiB | ≈ 165 MB (forge 73, scheduler 42, daprd 28, postgres 13, placement 9) | Pass |
| Disk | 10 GiB free host | Images ≈ 2.0 GB (worker 1.2 GB with harness CLIs); volumes 258 MB after about 130 qualification runs | Pass |
| Restart recovery | ≤ 120 s | 20 s restart; worker loss 86 s; sidecar loss 84–99 s; DB loss 51–52 s; scheduler loss 37 s | Pass |
| Cancellation cleanup | ≤ 30 s | 27 s | Pass, little headroom |
| Long histories | Bounded | 1,000-task run measured above; rollover bounds history size | Pass |
| Backup / restore / upgrade | Rehearsed | About 20 s each (P6-02, P6-03) | Pass |

### P6-05 platform and harness evidence — 2026-10-21

**Required support: Linux, macOS, and Windows.** The earlier Linux-only
declaration was corrected at the operator's request on 2026-10-21. Evidence
below covers Linux only; it does not remove desktop support. macOS and Windows
Podman-machine networking, credentials, mounts, path translation, watchers,
and performance still need host-specific qualification before P6-05 can close.

| Item | Result |
|---|---|
| Host | Ubuntu 24.04, kernel 7.0.0, Podman 4.9.3 **rootless**, cgroups v2 |
| User namespace | Container root maps to operator UID 1000; other UIDs map to subordinate range 100000+ |
| Rootless runtime | P6-01–P6-03 suites passed on rootless stacks `myforge-qual` and `myforge-qual2`, covering restart, worker loss, sidecar/DB loss, backup/restore, and upgrade/rollback |
| Mounts | Repository `.git` bind mounts and workspace integration verified by the failure and backup suites; grants file mounted `0600` root |
| Harness CLIs in `localhost/myforge-worker:2` | `copilot` 1.0.100, `claude` 2.1.304, `opencode` 1.19.3 install and report their pinned versions |
| Grant enforcement | A submission without a grant is rejected with the grant hint (P5-GATE evidence) |
| Stub harness | Qualified end to end (all P6 suites) |
| Real harness task with a granted credential | **Not run.** No operator credential was available in the isolated stack, and operator credentials were not used without consent. copilot, claude, and opencode are therefore **unqualified** for P6-GATE. |

Remaining: run one authenticated task per real harness on an isolated stack,
then record its outcome, commit, and audit trail. The repository remains a
standard Git repository hosted on GitHub regardless of harness; changing
harness must not require another repository credential. Provider authentication
is separate from GitHub repository access. Existing authorized provider logins
should be reused through a narrowly scoped handoff; the current service only
supports explicit credential grants and does not import host login state.
This also requires the ADR-075 task-UID fix first.

### P5-GATE evidence — 2026-10-22

**Status: accepted by the operator on 2026-10-21.** The original evidence
heading is retained for existing links; the acceptance date is 2026-10-21.

**Automated checks.**
- Launcher: typecheck, the full `node --test` suite, build, and
  `check:version` pass.
- Engine: typecheck passes, and `npm test --prefix tools/dapr-engine` passes
  170 tests, including the 17 PostgreSQL integration tests, run against a
  throwaway local PostgreSQL. The execution-host integration test covers a
  human-review wait, approval, and completion with no harness invocation and
  no target change.

**Live checks.** These ran against the rootless Podman runtime (Dapr 1.18.7)
with a registered smoke repository, `forge-smoke-gate`.

1. `runtime start` built `localhost/myforge-worker:2` with copilot 1.0.100,
   claude 2.1.304, and opencode 1.19.3.
2. `engine-run --harness copilot` with no grant was rejected at submission
   with the grant hint and exit 1. `runtime harness grant`, `list`, and
   `revoke` updated the worker's mounted grant file live, and revoke left
   `{"grants":{}}`.
3. `engine-run --harness stub --allow-noop` routed through the service and
   submitted `run_53f537554c52454890ef747781aca4ea`. T1 completed, and the
   human-review task T2 waited for approval without a harness.
4. `engine-run --stop` paused the run. A full `runtime stop`/`runtime start`
   followed, then `resume` resumed and attached to the same run, with T2
   still waiting.
5. The Console's `/api/service/runs` listed the run.
   `POST /api/tasks/human-review` approved T2 through the service, and T3
   then completed. The run reached `complete`, and the launcher
   fast-forwarded `main` to `forge/main`, which has the T1 and T3 commits.
6. An earlier run, `run_66ccb5c7b44443c6958fa1c8b62e1c35`, exposed the
   human-review gap: T2 failed three times with `execution-error`. That gap
   is fixed in this release.

**Originally outstanding; operator-confirmed passing on 2026-10-21.**
- A real-harness task run with a granted credential.
- A fresh install from a clean runtime data directory.
- A browser walkthrough of the Console Overview and Service runs views.

The operator reported that all gate tests worked and then ran the cleanup and
restore sequence: `runtime reset --confirm`, removal of the test runtime data
directory, restoration of `MyForge.pre-gate`, and
`runtime restore --from ~/myforge-backup-pre-gate --confirm`. This is
operator-reported acceptance, not an independently captured restore-integrity
check. P6-02 still requires coordinated backup/restore qualification, including
integrity and pending timers; the P5 walkthrough does not complete that task.

### P4-GATE acceptance evidence — 2026-10-19

The operator accepted P4-GATE after reviewing the completed P4-01–06 evidence.
The local engine typecheck passed, and `npm test --prefix tools/dapr-engine`
passed 124 tests with 15 PostgreSQL-dependent integration tests skipped because
`POSTGRES_TEST_URL` was not configured. All local conformance fixtures ran.

`node tools/dapr-spike/cli.js verify-orchestration` passed: the workflow kept
its identity through a worker restart during a retry timer and a full
Dapr/PostgreSQL stack restart while waiting for an external event, then resumed
and completed without manual state edits. The existing [P4-05 representative
execution evidence](#p4-05-representative-execution-evidence) records six
passing execution scenarios, including a real Copilot CLI harness; the
[P4-06 bound evidence](#p4-06-bound-evidence) records seven passing
history/concurrency scenarios. This gate does not establish production
authentication, host-level harness isolation, or release qualification; those
remain later-phase work.

### P4-06 bound evidence

On 2026-10-18, `npm run measure:bounds --prefix tools/dapr-engine -- --tasks 1000`
passed all seven scenarios against an ephemeral rootless Podman pod (Dapr
1.18.7 sidecar, Placement, Scheduler, and PostgreSQL workflow state) with a
host-native worker and stub task activities. History rows and bytes are read
from the Dapr PostgreSQL state table. Evidence is written to
`tools/dapr-engine/.runtime/p4-06-bounds.json` (gitignored).

| Scenario | Result |
|---|---|
| 1,000 tasks, default rollover (64 units) | 16 generations; run history peaked at 165 rows / 570,819 B and ended at 106 rows / 540,567 B; 454,562 B input re-carried per generation; 127 s |
| 1,000 tasks, no rollover (budget 1,000) | 1 generation; 2,361 rows / 1,812,768 B; 129 s |
| Retry storm | 32 tasks × 2 retries (96 operations); peak 8 active attempts, also the worker-wide peak; child history 18 rows / 3,990 B |
| Long approval wait | 60 s wait with a worker restart; run (11 rows / 7,146 B) and child (5 rows / 1,041 B) history unchanged throughout; the attempt then completed |
| Controls across rollover | 80 tasks, rollover every 3 units, 22 generations; 6 pause/resume pairs and a `replay-task` all applied (logical attempt 2 with a new operation ID); final run history 8 rows |
| Run admission | Two runs at concurrency 4 admitted, a third rejected with `worker-capacity-exhausted`; worker-wide peak 8; reservations released afterwards |
| Outcome and input bounds | A 2 MiB failure reason was stored as 4,000 characters (child history 6 rows / 9,160 B); the planner rejected 1,001 tasks and a 1,049,605 B submission |

With rollover, history size is bounded by the rollover budget and the
submission input rather than by manifest size; without it, history grows
linearly. A peak of 4 active attempts in the large-manifest runs reflects the
20 ms stub activity, not a limit.

The measurements found and fixed three defects:

- Dapr JS SDK 3.18's `WhenAllTask` never notifies a parent composite, so
  every controls-enabled run hung after its first wave.
- Its constructor forgets children that finished before construction, so a
  control that woke the run mid-wave stalled about one in six
  controls-across-rollover runs. After the fix, 10 of 10 looped runs passed.
- Failure-reason truncation appended its marker beyond the maximum.

Dapr 1.18's gRPC instance query omits custom status, so the harness reads it
from the HTTP workflow API. This evidence does not accept P4-GATE.

### P4-05 representative execution evidence

On 2026-10-18, `npm run verify:execution --prefix tools/dapr-engine -- --copilot`
passed against an ephemeral rootless Podman pod (Dapr 1.18.7 sidecar,
Placement, Scheduler, and PostgreSQL workflow state, published on loopback
only), with a host-native worker and the application PostgreSQL store. The
composed `ExecutionHost` (`tools/dapr-engine/orchestration/execution-host.ts`)
runs each attempt in an isolated workspace, admits the outcome through P4-02
verification, integrates through the P3 fenced authority, and records P4-04
status events. Scenarios:

- **Stub dependency chain:** three dependent tasks integrated in order.
- **Verification failure and retry:** attempt 1 failed with
  `validation-failed` and did not integrate; attempt 2 integrated.
- **Manual selection:** selecting `M-2` ran only its dependency closure
  (`M-1`, `M-2`).
- **Parallel isolated tasks:** two independent tasks ran concurrently in
  separate workspaces; the later integration rebased and revalidated.
- **Approval wait:** the attempt waited for an evidence-bound approval, the
  target branch was unchanged while it waited, and the resumed attempt
  integrated.
- **Real harness:** the Copilot CLI adapter received a scoped
  `COPILOT_GITHUB_TOKEN` from `gh auth token` via a secret reference, with an
  isolated home. It created `docs/hello.md`, the validation command passed,
  and the change integrated as one commit. The verifier refuses to write
  evidence that contains a resolved secret or the database password; the
  token was absent from the evidence and audit.

The run found and fixed two defects: approval wakes assumed the attempt-1
task workflow instance (the wait event now records `taskWorkflowInstanceId`),
and isolation settings were not forwarded to harness adapters. The harness
still runs as the operator's OS user, so target-repository filesystem
isolation is not enforced; that remains P6 security qualification. This
evidence does not accept P4-GATE.

### P4-01 live recovery evidence

On 2026-10-14, `node tools/dapr-spike/cli.js verify-orchestration` passed
against the local Dapr 1.18.7 stack and PostgreSQL workflow state. Run
`p4-6f2d9882-672f-4404-93fd-a64698c0d22b` kept the same workflow identity and
creation time through a worker restart during retry scheduling
(6,458 ms) and a full worker/sidecar/PostgreSQL/Placement/Scheduler restart
while the task-attempt child reported `waiting-for-control` before and after
recovery (41,033 ms). All five services shut down with
exit code 0.

The task attempt returned a retryable failure, retried after the 30,000 ms
durable timer, waited for the external event, and completed after the event
woke its deterministic child workflow. Its three distinct operation IDs were
`f53ec6ff-9dff-5c4a-aebd-3bad8ee79d72`,
`861336ee-acf6-5293-8b45-e7b9e0d83e82`, and
`b6207cab-4a5d-546a-a0e6-f8cb57a08bc5`; final task status was `complete`.
Activities and the submission are test fixtures, not harness execution or
control authorization. `resumeTask` authorization remains P4-03; verification
and handoff admission is P4-02. This evidence does not accept P4-GATE.

## P0 evidence — 2026-10-13

This section records preparation and the operator's explicit P0-GATE decision,
not release qualification. On 2026-10-13, the operator accepted P0-01/P0-02,
the compatibility register, and proposed budgets, then approved P0-GATE and
authorized the isolated P1 spike. The agent does not generate the human-review
JSON file. The P0 checkboxes above are ticked because this evidence and the
gate acceptance are merged. Baseline work ran against the existing engine
without changing it.

### Deliverable status

| Work package | Evidence produced | Remaining acceptance |
|---|---|---|
| P0-01 | Execution/test inventory below cross-checked against current CLI/engine call paths | Accepted by operator on 2026-10-13 |
| P0-02 | Caller/authority inventory below cross-checked; Console write boundaries clarified | Accepted by operator on 2026-10-13 |
| P0-03 | Engine/adapter baselines passed; launcher clean install and checks now pass | Baseline disposition complete; see rerun evidence below |
| P0-04 | Compatibility dispositions below accepted by the operator on 2026-10-13 | Acceptance recorded; applies to the proposed replacement contract |
| P0-05 | [Foundation PRD](docs/PRD.md) and [feature](docs/features/dapr-foundation.md); four structured contracts validate with zero errors/warnings | Specialist generation is intentionally deferred until after P0-GATE and before compiling a runnable manifest |
| P0-06 | Budgets/trust boundaries below accepted by the operator on 2026-10-13 | Acceptance recorded; startup, memory, and restart thresholds measured in P1; remaining limits stay unqualified |
| P0-GATE | Explicit human-review contract `P0-GATE` | Accepted by operator on 2026-10-13; isolated P1 authorized; no review JSON generated |

At the time of the P0 review, only P0/P1 execution contracts were authored.
After P1-GATE passed, P2's canonical feature and versioned contracts were
authored; P3–P8 remain gated roadmap work. Preparing the isolated SDK experiment
and P2 contract design does not authorize production runtime changes or engine
replacement.

### Baseline environment and results

Host: Linux `6.17.0-1022-azure`, x86_64; Node `v24.21.0`, npm `11.19.0`,
rootless Podman `4.9.3`. These are observed test versions, not a promised support
matrix. Baseline logs are session-local under `/tmp/myforge-p0-baseline`, not
committed repository artifacts.

| Package | Setup | Tests | Typecheck | Other checks |
|---|---|---|---|---|
| Workflow engine | `npm ci` passed | `npm test`: 283 passed, 7 skipped, 0 failed; 27.76 s | Passed | Skips are not durability/platform evidence |
| Execution adapter | `npm ci` passed | `npm test`: 49 passed, 0 failed; 9.87 s | Passed | Canonical validation below |
| Launcher | `npm ci --ignore-scripts` passed | `npm test`: 295 passed, 0 failed | Passed | Build and `check:version` passed |

The initial launcher baseline was blocked by a package self-dependency on
`file:forge-launcher-1.0.0-beta.6.tgz`. The self-dependency was not used by source
code, and the existing beta.6 archive's package metadata did not declare it.
Removed the accidental self-dependency from `scripts/forge-launcher/package.json`
and refreshed its lockfile; no tarball was synthesized. A clean install, tests,
typecheck, build, and version check then passed. This packaging correction is
separate from the workflow-engine replacement.

Canonical authoring check:
`npm run validate-prd --prefix templates/skills/forge-execution-adapter -- /home/runner/work/my-forge/my-forge`
reported four tasks, zero errors, zero warnings. This validates source contracts
and dependencies, not team generation, human approval, or live infrastructure.

### Execution semantics and decisive checks

Source paths in these tables are repository-relative locators; they resolve under
`/home/runner/work/my-forge/my-forge`. `engine/` below abbreviates
`templates/skills/forge-workflow-engine/scripts/`.

| Behavior | Current source boundary | Existing checks | Replacement disposition |
|---|---|---|---|
| Task/phase readiness; complete or skipped prerequisites | `engine/task-graph.ts:17-57`, `engine/engine.ts` | `engine/engine.test.ts`, launcher Console tests | Preserve one shared definition |
| Manual single/range/list selection and transitive dependencies | `engine/engine.ts:218-238`, `engine/types.ts:15-22` | `engine/engine.test.ts`, `engine/cli.test.ts` | Preserve; snapshot selection |
| Owner exclusivity, bounded waves and fallback capability notice | `engine/engine.ts:297-309,846-876`, `engine/sandbox.ts` | `engine/engine.test.ts`, `engine/sandbox.test.ts` | Preserve effective limits; no unisolated parallel writes |
| Retryable versus configuration/exception/cancelled failures | `engine/engine.ts:499-720`, `engine/types.ts:89` | `engine/engine.test.ts`, harness tests | Durable retry timers; preserve classification |
| Timeouts and abort/process cleanup | `engine/harness/run.ts`, harness adapters | `engine/harness/run.test.ts`, adapter tests | Separate process cancellation from workflow termination |
| Expected outputs and no-op checks | `engine/verify.ts`, `engine/engine.ts:602-642` | `engine/verify.test.ts`, `engine/engine.test.ts` | Preserve; allow-noop never bypasses missing outputs |
| Structured report and mandatory validation | `engine/task-result.ts`, `engine/engine.ts:628-636` | `engine/task-result.test.ts`, `engine/task-execution.test.ts` | Preserve all five gate outcomes |
| Typed artifact creation and compact predecessor context | `engine/artifacts.ts`, `engine/engine.ts:414-450,666-691` | `engine/artifacts.test.ts`, `engine/request.test.ts` | Preserve projection; change persistence interface |
| Human review and changed evidence invalidation | `engine/task-context.ts`, `engine/engine.ts:785-800,1007-1037` | `engine/task-context.test.ts`, `engine/engine.test.ts` | Preserve operator gate; bind immutable evidence and authenticated identity |
| Running-task reset, manifest reconciliation, stale controls/blockers | `engine/state.ts:62-87`, `engine/engine.ts:770-835` | `engine/engine.test.ts` | Replace file mutation with versioned snapshots and explicit reconciliation |
| Task replay | `engine/engine.ts:1107-1200` | `engine/engine.test.ts` | Preserve explicit rerun; distinguish history replay |
| Serialized sandbox integration/overlap checks | `engine/engine.ts:874-902`, `engine/sandbox.ts` | `engine/sandbox.test.ts`, `engine/engine.test.ts` | Fenced coordinator and expected-head checks |
| Auto-commit and non-fatal commit failures | `engine/commit.ts:60-68`, `engine/engine.ts:926-943` | `engine/commit.test.ts`, `engine/engine.test.ts` | Preserve option; require durable checkpoints independently |

Test presence is not acceptance proof; use the results above and rerun affected
checks when behavior changes. The future durability, fencing, and hosted tests
do not exist merely because comparable local-engine tests pass.

### Caller and authority inventory

| Caller / authority today | Persistent inputs/outputs and controls | Migration owner / task |
|---|---|---|
| Engine CLI and state manager | Manifest/state/progress/audit/artifacts; control polling and PID; human review files | Runtime, P4-01/P4-03/P4-04 |
| Launcher `engine-run.ts:46-211` | Installs local skills, compiles missing manifest, forwards flags, tees log; stop/pause path | Launcher, P5-03 |
| Launcher `cli.ts`, `launcher.ts` (resume pipeline), `engine-run.ts` | Selects stages, dispatches/detaches local processes and resumes repository runs | Launcher, P5-03 |
| `bootstrap.ts`, `stage-resources.mjs` | Copies skills/personas/resources, initializes ignore rules and configuration | Packaging, P5-03 |
| Console `paths.ts:90-124`, `jobs.ts`, `control.ts` | Reads manifest/state/log/PID; spawns jobs; persists Console job records and control requests; signals processes | Console, P5-04 |
| Console `repo.ts` | **Also writes workflow state, manifest, and engine config** for reconciliation, changed-task resets, timeouts, selections, and run settings; not merely read-only | Console + contracts, P2-01/P5-04 |
| Console dashboard `state.ts`, `views/board.ts`, `views/tasks.ts` | Projects status/readiness, artifacts and review controls; uses installed engine readiness logic | Console, P5-04 |
| Engine `viz/server.ts` | Reads manifest/state/audit; serves workflow visualization | Visualization, P5-04 or explicit retirement decision |
| `forge-auto-build/SKILL.md` | Fast-path compile/detached run and file polling | Skills, P5-03 |
| Shell/PowerShell wrappers | Delegate to launcher executable | Launcher, P5-03 |

The engine serializes its own state and integration writes, but **the repository
does not have a universal single-writer guarantee**: Console mutation paths must
also migrate behind the service. Do not treat all file consumers as read-only.
P5 must audit dynamic engine imports and remove writable authority, not only PID
polling. Artifacts/review evidence can contain sensitive content.

### Compatibility register — accepted 2026-10-13

All current production commands and settings remain unchanged in P0/P1.
These dispositions describe the future replacement and were accepted at P0-GATE.

| Surface | Disposition | Future contract |
|---|---|---|
| Launcher engine-run/resume/bootstrap/console; wrapper entry points | Preserve entry intent | Route execution through Forge service; bootstrap prepares client/resources, not another scheduler |
| Engine run/status/replay/pause/stop | Preserve intent; migrate implementation | Versioned service operations; explicit replay allocates new logical attempt identity |
| approve-task with reviewer/evidence/confirm-human-review | Change security boundary | Operator-only authenticated approval bound to manifest/evidence; confirmation flag is not identity |
| Standalone viz / `--viz`, `--port`, `--viz-port`, `--no-open` | Explicitly migrate or retire in P5 | Console/service view; maintain browser-open intent, not old process authority |
| `--repo`, `--harness`, `--yes`, launcher `--dry-run` | Preserve meaning where applicable | Repository-scoped submission, selected harness, non-review confirmation and no-effect preview |
| `--max-retries`, `--retry-delay-ms`, `--heartbeat-ms`, `--concurrency`, `--task-timeout-ms` | Preserve limits | Durable scheduling timers; runtime heartbeats are telemetry, not completion evidence |
| `--execution-mode`, `--selection-scope`, `--selected-tasks` | Preserve | Immutable run selection and prerequisite expansion |
| `--allow-noop`, `--run-validation` | Preserve | Structured validation always required, no missing-output bypass |
| `--log-harness-activity` / `--no-log-harness-activity` | Preserve opt-in | Redaction and bounded retention; logging must not leak secrets |
| `--auto-commit` / `--no-auto-commit`, `--commit-message-template` | Preserve | Disabled auto-commit still publishes durable patch/bundle/tree; not merely an ephemeral dirty worktree |
| Sequential dirty repository | Deliberate safety change | Managed clean workspace by default; reject dirty shared mounts until explicit consent/checkpoint policy exists |
| Commit failure | Preserve warning-only behavior conditionally | May remain non-fatal only if accepted changes/checkpoint are durable and reconcilable; failed integration/publication blocks success |
| Graceful pause/stop | Preserve resumable meaning | Stop/pause do not become terminal cancellation; acknowledge scheduling state separately from subprocess state |
| Immediate cancellation | Explicit distinct operation | Kill owned work, retain diagnostics, suppress late results; workflow termination alone is insufficient |
| Recompile/reconcile/replay | Explicit change | Never silently replace an in-flight immutable manifest; carry verified completed work into an explicit new snapshot/run |
| Writable files, PID and direct state reset | Retire authority | Read-only exports only; all writes/control routed through service |

Environment register from engine CLI/adapters and launcher forwarding:

- Preserve submission settings `FORGE_ENGINE_HARNESS`, `FORGE_ENGINE_YES`,
  `FORGE_ENGINE_HEARTBEAT_MS`, `FORGE_ENGINE_CONCURRENCY`,
  `FORGE_ENGINE_TASK_TIMEOUT_MS`, `FORGE_ENGINE_ALLOW_NOOP`,
  `FORGE_ENGINE_RUN_VALIDATION`, `FORGE_ENGINE_LOG_HARNESS_ACTIVITY`,
  `FORGE_ENGINE_AUTO_COMMIT`, and `FORGE_ENGINE_COMMIT_MESSAGE_TEMPLATE`.
- Preserve launcher compilation/retry intent for `FORGE_ENGINE_GRANULARITY`,
  `FORGE_ENGINE_MAX_RETRIES`, `FORGE_ENGINE_RETRY_DELAY_MS`; note these are not all
  read directly by the engine CLI. Preserve selected precedence explicitly.
- Migrate `FORGE_ENGINE_VIZ`, `FORGE_ENGINE_VIZ_PORT` with the visualization decision.
- Preserve harness configuration boundary: `OPENCODE_BIN`, `OPENCODE_EXTRA_FLAGS`,
  `COPILOT_BIN`, `COPILOT_EXTRA_FLAGS`, `CLAUDE_BIN`, `CLAUDE_EXTRA_FLAGS`,
  `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `FORGE_ENGINE_NATIVE_AGENT`,
  `STUB_FAIL_TASK_IDS`, `STUB_DELAY_MS`. Resolve binaries inside the approved
  worker environment, not by blindly reusing host absolute paths or secret values.
- Host discovery variables such as `PATH`/`PWD` are execution environment, not
  portable run identity; rebuild them deliberately per workspace.

State field register (`engine/types.ts:24-75,220-260`):

- Preserve logical `runId`, `startedAt`, `lastUpdatedAt`, `harness`, `status`,
  `currentPhase`, `tasks`, `blockers`, and `selection` as versioned status fields.
- Replace `manifestPath`/`manifestVersion` with durable snapshot identity/digest;
  expose original location only as optional provenance.
- Preserve task `taskId`, `status`, `ownerAgent`, `startedAt`, `completedAt`,
  `attempt`, `outputFiles`, `errorMessage`, `failureKind`, `attemptHistory`,
  `artifactId`, `inputArtifactIds`, `validationLimitations`. Bound `agentOutput`
  and move large/sensitive payloads to artifact references.
- Preserve attempt `attempt`, `outcome`, `reason`; replace local `resultPath` with
  an immutable retrievable reference. Preserve gate
  `gate/status/reason/evidence`; do not reinterpret skipped as passed.
- Preserve audit action and logical metadata: `timestamp`, `runId`, `taskId`,
  `phaseId`, `attempt`, `outputFiles`, `durationMs`, `note`, `artifactId`,
  `artifactType`, `inputArtifacts`, `commitSha`, `sourceTokenEstimate`,
  `projectedTokenEstimate`, `reductionPercent`; migrate `resultPath` similarly.
  Replace embedded `auditLog` as an authoritative mutable array with sequenced
  durable audit queries and bounded compatibility exports.
- Local run states are running/paused/complete/failed; task states are
  pending/running/complete/failed/skipped. Model terminal cancellation explicitly,
  version exports, and document any new status values before client migration.

### Proposed acceptance budgets and trust boundaries

**Operator-accepted thresholds (2026-10-13):** these are qualification limits,
not production SLOs. Measurements and remaining gaps are recorded in the P1
evidence below.

| Area | Proposed threshold / boundary |
|---|---|
| Initial advertised profile | Linux rootless Podman on a 2-vCPU, 8-GiB RAM host with 10 GiB free disk; qualify desktop profiles separately |
| Cached startup readiness | Application + sidecar + stores ready within 180 s, excluding first image pulls/build |
| Idle local stack | At most 3 GiB total resident/container memory; record limitations if rootless accounting is unavailable |
| Restart recovery | Same stub workflow visible and resumed within 120 s after service readiness, excluding a deliberately unexpired durable timer |
| Cancellation | Owned stub process cleanup within 30 s; late completion cannot be accepted |
| Foundation payloads | Stub metadata only, no repository/provider payloads; proposed production artifact cap 32 MiB and bounded metadata cap 256 KiB require later qualification |
| Retention proposal | 7 days for disposable diagnostics after terminal runs; preserve checkpoint/evidence until no live workflow/review references it; no automatic deletion in spike |
| Offline claim | Pre-cached stub run with no provider/network downloads; local-model execution separately qualifies the selected model provider |
| Trust boundary | Operator-authored repositories/commands only in foundation; validation is arbitrary code, not a safe sandbox by default |
| Privileges | No rootful container requirement, home-directory mount, Podman/Docker socket mount, or task access to unrelated credentials |
| Services | Infrastructure private; any host application endpoint loopback only; production browser/API authentication belongs to P5 |
| Recovery claim | Both PostgreSQL workflow data and Scheduler storage persisted; clean-host failover requires shared artifact/Git reconstruction in P8 |

## P1 spike evidence — 2026-10-13

The isolated live verification passed, and the operator accepted P1-GATE on
2026-10-13, authorizing P1-06 and P2. This does not qualify a production
replacement. Tracking is in [P1 issue #3](https://github.com/McFuzzySquirrel/my-forge/issues/3).
The accepted architecture is recorded in [ADR-066](docs/adr/066-dapr-workflow-full-replacement-architecture.md).
No human-review JSON is generated by the agent. `evidence.json` records the
measurement-time snapshot; its `phaseGateAccepted` value predates the later
operator acceptance recorded here.

| Work package | Recorded evidence | Remaining disposition |
|---|---|---|
| P1-01 | Dapr 1.18.7, JS SDK 3.18.0, PostgreSQL state component v2, rootless Podman 4.9.3, host Node 24.15.0, worker Node 24.11.1; official pinned-release sources and image digests are in `tools/dapr-spike/evidence.json`. Registration, activity, timer, event, status, restart replay, and graceful SIGTERM shutdown exercised. | Retry policy is not exposed by the released `callActivity` API; termination/suspend/resume/purge methods were inspected but not qualified. |
| P1-02 | Strict TypeScript workflow/worker/readiness sources build and pass package checks; one application registers the workflow and activity. | Keep the language/topology decision provisional: the SDK's broad `TWorkflow` alias does not statically constrain registration callbacks. |
| P1-03 | Rootless Podman stack uses private `network=none`, zero published ports, PostgreSQL workflow state, Scheduler storage, and separate artifact volume; three volumes persist across stop. | Isolated stub topology only; not a production service or manifest runner. |
| P1-04 | Same workflow ID and creation timestamp recovered through worker/sidecar and full-stack restarts; timer and approval phases survived; output artifact digest matched. Worker and service-container stop exit codes were 0; Podman infra exited 137 during pod teardown. Full restart recovery took 40.4 s. | Clean restart only; no crash/partition, cross-host failover, or explicit history enumeration. |
| P1-05 | Cached startup readiness 8.1 s; five idle memory samples included the pod infra container, peaking at 129,833,150 bytes (123.82 MiB) against the accepted 3 GiB ceiling. Rootless, SELinux, readiness, private-port, signal, and cached-offline observations are recorded. | Cancellation, fresh/offline installation, host loopback forwarding, backup/restore, and local-model paths remain unqualified. |

The machine-readable observations, image digests, exact phase timings, and
limitations are in [`tools/dapr-spike/evidence.json`](tools/dapr-spike/evidence.json).
The reproducible live command and volume-preserving stop procedure are in the
[testing guide](docs/testing-guide.md). P1-06 and P2 are authorized; P3–P8 remain
closed until their own gates pass.

---

# Historical Completed Plan: Consolidate Forge CLI Scripts into a Single `forge-launcher` npm Package

**Branch:** `optimization/task-breakdown`
**Status:** Complete
**Decision:** [ADR-023: Forge Launcher as a Node npm Package](docs/adr/023-forge-launcher-npm-package.md)

## Problem

The forge CLI surface is implemented twice, once per platform, for every entry
point:

| Entry point | Bash | PowerShell | Approx. lines each |
|-------------|------|-----------|--------------------|
| `forge-launcher` | `scripts/forge-launcher.sh` | `scripts/forge-launcher.ps1` | ~1100 |
| `bootstrap` | `scripts/bootstrap.sh` | `scripts/bootstrap.ps1` | ~190 |
| `forge-engine-run` | `scripts/forge-engine-run.sh` | `scripts/forge-engine-run.ps1` | ~140 |

Every feature since ADR-010 (auto-draft, headless, engine decision, parallel
dispatch, task timeouts) must be written twice in two languages. The two
implementations have already drifted on behavior - e.g. the "Launch GitHub
Copilot CLI / claude / opencode now?" prompts default to **no** in
`forge-launcher.sh` (`prompt_yn`, default `n`) but **yes** in
`forge-launcher.ps1` (`Read-YesNo ... "y"`). The interactive UX (Tab-complete
path input, spinners, heartbeats) is hand-rolled with bash readline / PSReadLine
hacks and `tput`.

The heavy-lifting tooling (workflow engine, execution adapter, workforce
compiler) is already Node/TypeScript under `templates/skills/`. The CLI layer is
the only part that isn't.

## Goal

1. A single **`forge-launcher` npm package** (Node/TypeScript) that replaces
   all six shell scripts.
2. Cross-platform in one codebase; Windows users stop needing PowerShell 5.1+.
3. Installable/runnable anywhere: `npx forge-launcher`, versioned releases -
   no need to clone the forge repo first.
4. Bundle `templates/` + `docs/prompt-playbook.md` as package resources so the
   package bootstraps standalone.
5. Keep `scripts/*.sh|.ps1` as legacy wrappers that delegate to the Node
   package until parity is proven, then remove them.
6. **Interactive TUI** (full) built on `@clack/prompts` - the only runtime
   dependency - replacing the hand-rolled bash/PSReadLine UX with clack
   `select`/`confirm`/`text`/`multiline`/`path` prompts and clack spinners for
   long-running steps (output tee'd to a per-run log).

## Design

Single package at `scripts/forge-launcher/` with three subcommands:

```
forge-launcher                          # full 9-step interactive flow
forge-launcher --non-interactive
forge-launcher --headless [--dry-run]
forge-launcher --draft
forge-launcher bootstrap [TARGET] [--harness H] [--force]
forge-launcher engine-run --repo R [--harness H] [--concurrency N]
                             [--task-timeout-ms M] [--yes] [--dry-run]
```

Structure:

```
scripts/forge-launcher/
  package.json          # name: forge-launcher, bin: forge-launcher
  tsconfig.json
  resources/            # copies of templates/ + docs/prompt-playbook.md
    templates/agents/…
    templates/skills/…
    prompt-playbook.md
  scripts/
    cli.ts              # entry; arg parsing + subcommand dispatch
    paths.ts            # expandPath, resolveInputFile, detectRepoRoot
    prompts.ts          # TUI prompts (clack select/confirm/text/multiline/path
                        #   when TTY; readline fallback when piped), cancel handling
    terminal.ts         # spawn CLI in a separate terminal (cross-platform)
    format.ts           # colors + step/ok/warn/fail/info + spinner + runLogged
    launcher.ts         # the 9-step flow (port of forge-launcher.sh)
    bootstrap.ts        # template deployment (port of bootstrap.sh)
    engine-run.ts       # standalone engine runner (port of forge-engine-run.sh)
  scripts/*.test.ts     # node --test, mirrors test-forge-launcher.sh surface
```

Runtime dependency: `@clack/prompts` (interactive TUI). Compiled `dist/` ships
to consumers; `tsx`/`typescript` remain devDependencies.

Dev-time resolution order for resources: `../../templates`, `../../docs` (the
live forge repo) first; fall back to bundled `resources/`. Published package
ships `resources/` only.

## Phases

### Phase 1 - Decision

- Write **ADR-023** superseding ADR-010's "zero new dependencies / Tier 1"
  clause. Justification: Node is already the forge runtime (engine skills), the
  drift between the two implementations is a real defect, and a single
  language + test suite beats two. Document the trade-offs (Node becomes a
  prerequisite; interactive terminal still required for Tier-1 UX).

### Phase 2 - Scaffold the package

- `scripts/forge-launcher/` with `package.json` (bin `forge-launcher`),
  `tsconfig.json` (mirror the engine package: ES2022, strict, tsx), and empty
  module skeletons.
- `resources/` staging script or `files` field wiring to bundle
  `templates/` + `docs/prompt-playbook.md` for the published package.

### Phase 3 - Port `bootstrap`

- `bootstrap.ts`: harness→root mapping (agents→`.agents`, github→`.github`,
  claude→`.claude`, opencode→`.opencode`), copy agents + skills +
  prompt-playbook, exclude `node_modules`/`dist`, `.agents/` → `ROOT/` path
  rewrite in `.md` files for non-default harnesses, `.gitignore` hygiene
  (`node_modules/`, `docs/engine-run.log`), overwrite confirmation honoring
  `--force`.
- Legacy `scripts/bootstrap.sh|.ps1` become thin wrappers that exec
  `forge-launcher bootstrap`.

### Phase 4 - Port `forge-launcher` (9-step flow)

Faithful port of `forge-launcher.sh`:
1. Pre-flight (git/gh/copilot/opencode/claude; exit if git missing).
2. Harness selection (numbered menu; `FORGE_HARNESS_CHOICE`).
3. Repo creation (`gh repo create --clone` or `git init` + optional remote;
   `FORGE_REPO_*`).
4. Bootstrap delegation → `bootstrap.ts`.
5. Idea capture (multi-line; `FORGE_IDEA`; `docs/IDEA.md` + `IDEA.md`).
6. PRD + research/seed docs (`FORGE_PRD_FILE`, `FORGE_RESEARCH_FILES`, paste).
7. Commit + push (`chore: bootstrap MyForge`).
8. Auto-build launch: auto-draft menu (`--draft` / `FORGE_AUTO_DRAFT=1`),
   headless mode (`--headless` / `FORGE_RUN_WITH` / `FORGE_WORKFLOW_ENGINE`),
   engine decision (detached run / print command / skip), CLI spawn
   (`copilot`/`opencode`/`claude` in a separate terminal).
9. Completion summary.

**Drift fixes while porting:**
- Launch-CLI prompt default becomes `n` everywhere (matches bash / documented
  `[y/N]`), fixing the ps1 `y` divergence.
- The engine command printed in Steps 8/9 references the new
  `forge-launcher engine-run` (not the shell script).
- Long-running steps show a clack **spinner** (elapsed message honours
  `FORGE_HEARTBEAT_INTERVAL`); output is tee'd to a per-run log in
  `os.tmpdir()` (`forge-launcher-<pid>.log`) so nothing is lost, with the log
  tail printed on failure. When stdout is not a TTY (CI/piped) the step runs
  directly with no spinner, keeping output clean.

### Phase 5 - Port `forge-engine-run`

- `engine-run.ts`: repo detection (walk up for `.git`), locate bootstrapped
  `forge-workflow-engine` / `forge-execution-adapter` under the harness dirs,
  adapter install + manifest compile, engine `npm install`, then
  `npm run workflow-engine -- run` with harness/concurrency/task-timeout/yes
  flags; `--dry-run` prints only. Honor `FORGE_ENGINE_*` env vars.
- Detached engine start (used by launcher Step 8 choice 1) uses
  `child_process.spawn(..., { detached: true, stdio: [log] })`.

### Phase 6 - Interactive TUI (full)

- Add `@clack/prompts` as the package's **single runtime dependency**.
- `prompts.ts`: clack `select` (harness, PRD menu, engine decision), `confirm`
  (all yes/no), `text` (repo name/description/visibility), `multiline` (idea /
  PRD paste, Enter-twice submits), and `path` (autocomplete file/dir picker
  replacing hand-rolled Tab completion) - each with a readline fallback for
  piped/non-TTY stdin and `isCancel` → clean exit (code 130).
- `format.ts`: `runWithHeartbeat` becomes a clack **spinner** (message updates
  honour `FORGE_HEARTBEAT_INTERVAL`); new `runLogged` tees child output to a
  per-run log; `printLogTail` surfaces the log on failure.
- Long-running steps (gh repo create, bootstrap, git push, headless skill
  runs) route through spinner + tee-log.
- Verified end-to-end under a pty (pexpect): full interactive run completes
  with idea captured, templates bootstrapped, and the bootstrap commit created.

### Phase 7 - Tests

- Port the `test-forge-launcher.sh` acceptance surface to `node --test`
  (consistent with the engine packages): static content checks move to
  unit tests on the TS modules; non-interactive end-to-end runs assert the
  created directory layout per harness.
- `scripts/test-forge-launcher.sh` stays as the legacy oracle until parity is
  confirmed, then is retired.
- Bootstrap and engine-run get focused unit tests (harness mapping, path
  rewrite, gitignore hygiene, repo-root detection).
- Interactive TUI is covered by the non-interactive suite (clack is bypassed
  when stdin/stdout are not TTY) plus the pexpect-driven pty smoke run.

### Phase 8 - Docs

- Rewrite `docs/forge-launcher.md` usage to `npx forge-launcher …`;
  document subcommands, flags, and env vars (unchanged contract).
- Update `docs/testing-guide.md` commands and `README.md` quick-start.
- Mark `scripts/*.sh|.ps1` as legacy delegating wrappers.

### Phase 9 - Deprecate / remove shell scripts

- Convert `scripts/forge-launcher.sh|.ps1`, `bootstrap.sh|.ps1`,
  `forge-engine-run.sh|.ps1` into thin wrappers delegating to the package
  (kept for CI/scripts that invoke them), or delete them once docs + tests no
  longer reference them. Decision: **keep as delegating wrappers** for one
  release, delete in the following release.

### Phase 10 - Verify

- `npm test` (all packages) and `npm run typecheck` in the new package.
- Run the launcher `--non-interactive --dry-run` and a full non-interactive
  bootstrap smoke test into a temp repo.
- `npm pack` → install the tarball globally → run the bundled-resources path
  standalone from outside the forge repo.
- Interactive pty run (pexpect) exercising every prompt type.

## Out of scope

- Bundling `bootstrap`/`forge-engine-run` from target repos - the launcher only
  bootstraps *from* the package; target repos keep their skill packages.
- Publishing to npmjs.org in this plan (local `npm pack` + `npx` smoke only).

## Future work

Open items deliberately not done in this plan - candidates for a follow-up.

### Publish the package

- Publish `scripts/forge-launcher/` to npmjs.org (or a private registry) as
  `forge-launcher` v1.0.0. `npm pack` + a `prepack` staging step are verified;
  actual publishing (auth, scoping, CI release) is not.
- Add a release workflow (GitHub Actions on tag → `npm publish`).
- Decide whether a repo-side `scripts/` entry point is still needed once
  published, or if `npx forge-launcher` fully replaces it.

### Delete the legacy shell wrappers (next release)

- `scripts/forge-launcher.sh|.ps1`, `bootstrap.sh|.ps1`,
  `forge-engine-run.sh|.ps1` are kept as thin delegating wrappers for one
  release. Once docs + tests no longer reference them, delete them.
- Retire `scripts/test-forge-launcher.sh` and
  `scripts/smoke-test-launcher-terminal-support.sh` (currently delegating
  runners) when the wrappers go.

### Full-shell wrapper robustness

- The bash wrappers prefer `dist/cli.js` (built), then `tsx`. In a fresh clone
  without `npm install` they print a build hint. Consider compiling on
  install (postinstall) or committing `dist` so wrappers always work offline.

### Behavioural parity checks (minor)

- Multi-line idea/PRD capture uses clack `multiline` (Enter-twice submits) in a
  TTY and a blank line in the readline fallback; bash used Ctrl+D. Confirm the
  documented interaction matches.
- The detached engine start in Step 8 writes to `docs/engine-run.log` via
  `child_process` spawn; verify `.out`/`.err` split used by the ps1 variant is
  not needed by consumers.
- Spinner steps require a TTY on stdin **and** stdout; bash only checked
  stdout. Confirm CI behaviour is identical.

### Web / richer frontend

- The interactive layer is now a clack TUI. A separate web UI (e.g. a local
  `localhost` wizard) or full-screen terminal UI could be layered on top of
  the same prompt functions.

### Package hygiene

- The package ships compiled `dist/`; runtime deps are just `@clack/prompts`.
  `tsx`/`typescript`/`@types/node` remain devDependencies. Revisit whether the
  `bin` should point at a compiled entry (already `dist/cli.js`) once the
  publish workflow exists.
- Consider splitting `bootstrap`/`engine-run` into their own bin entries
  (`forge-bootstrap`, `forge-engine-run`) if subcommand discoverability
  becomes an issue.
