# Active Plan: Dapr Engine Replacement

**Created:** 2026-10-13

**Status:** P0-GATE and P1-GATE accepted by the operator; P1-06 is recorded in
ADR-066 and the P2 v1 contract is drafted. P2-03 extraction is underway in
[issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4); conformance
fixtures and P2-GATE remain pending. The runtime remains an experimental spike,
not a production replacement.

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
| P2 — Reusable execution boundary | P1 gate | Engine + contracts | Contracts authored; P2-03 extraction in progress | [P2-03 issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4); [P2 feature](docs/features/dapr-execution-boundary.md); [v1 contract](docs/contracts/dapr-execution-v1.md) |
| P3 — Durable execution and integration | P2 gate | Engine + storage | Not started | Unassigned |
| P4 — Complete local vertical slice | P3 gate | Runtime + platform | Not started | Unassigned |
| P5 — Launcher and Console migration | P4 gate | Launcher + Console | Not started | Unassigned |
| P6 — Recovery and release qualification | P5 gate | QA + security + platform | Not started | Unassigned |
| P7 — Cutover and legacy retirement | P6 gate | Release + documentation | Not started | Unassigned |
| P8 — Hosted deployment | P6 gate; public release after P7 | Platform + security | Not started | Unassigned |

P1's spike may contain minimal throwaway/test activities; it is not the production
engine. P3 can develop storage and execution adapters in parallel after P2, but
integration remains serial at the repository mutation boundary. P8 design work
may overlap P7 after local qualification; hosted availability is a separate gate.

## P0 — Establish the baseline and implementation contract

**Deliverables:** behavior inventory, canonical work breakdown, compatibility
matrix, agreed acceptance budgets, and a baseline test record.

- [ ] **P0-01 — Inventory execution semantics.** Map DAG/phase dependencies,
  skipped tasks, manual selection and its transitive dependencies, per-owner
  concurrency, retries, timeouts, replay, reconciliation, and task outcome rules
  to current implementation and tests.
- [ ] **P0-02 — Inventory callers and state ownership.** Identify launcher,
  Console, bootstrap, auto-build, dashboard, and visualization dependencies on
  state files, audit files, control files, PID signalling, and dynamic imports.
  Record which caller migrates in which task.
- [ ] **P0-03 — Establish test baselines.** Run existing engine, execution adapter,
  and launcher tests/typechecks plus launcher build/version checks; record
  environment and results. Separate pre-existing failures from replacement
  regressions without removing unrelated tests.
- [ ] **P0-04 — Define compatibility decisions.** Classify each public command,
  flag, environment variable, state field, and lifecycle behavior as preserved,
  deliberately changed, or retired. Explicitly decide auto-commit disabled mode,
  current non-fatal commit failures, dirty repositories, and stop versus pause.
- [ ] **P0-05 — Author canonical implementation features.** Register the work in
  the repository's canonical requirements layout, with acceptance criteria and
  dependencies linked to these work-package IDs. Keep unresolved SDK choices as
  decisions rather than assuming an implementation language.
- [ ] **P0-06 — Agree measurable budgets and threat boundaries.** Record supported
  host platforms, startup/RAM/disk budgets, recovery targets, retention, artifact
  limits, cancellation deadlines, trusted repository assumptions, and allowed
  harness/validation privileges. Measurements must have explicit pass thresholds
  before qualification.
- [ ] **P0-GATE:** Every existing execution/control behavior has an owner and
  compatibility disposition; baseline results and acceptance thresholds are
  recorded; canonical work is validated.

**Starting points:** `templates/skills/forge-workflow-engine/scripts/engine.ts`,
`types.ts`, `state.ts`, `control.ts`, `task-graph.ts`, and corresponding tests;
`scripts/forge-launcher/scripts/engine-run.ts`, `resume.ts`, and `console/`;
`templates/skills/forge-auto-build/SKILL.md`.

## P1 — Prove released SDK support and rootless Podman operation

**Deliverables:** reproducible spike, pinned compatibility matrix, local topology,
and an accepted architecture decision.

- [ ] **P1-01 — Verify released capabilities.** Select exact runtime, JavaScript
  Workflow SDK, Node, Podman, state component, and image versions. Check released
  support for workflow registration, activities, durable timers, external events,
  retries, cancellation controls, history replay, and graceful worker shutdown.
  Record official evidence and known limits; default-branch docs are not proof.
- [ ] **P1-02 — Resolve SDK/language gate.** Prefer TypeScript and one workflow
  application registering all workflows/activities. If released support is
  insufficient, explicitly approve a supported orchestration language with a
  Node execution boundary or stop and revisit; do not invent a workflow protocol.
- [ ] **P1-03 — Stand up the local spike.** Use documented Podman support and
  explicit networking for application/sidecar, Placement, Scheduler, PostgreSQL
  actor state, and separate artifact storage. Persist database, Scheduler/etcd,
  and artifact data; keep infrastructure ports private.
- [ ] **P1-04 — Exercise durability.** Run a stub activity, durable timer, and
  approval wait; restart the app/sidecar, then the infrastructure stack. Verify
  the same workflow resumes with preserved history, no volume deletion, and no
  manual edits.
- [ ] **P1-05 — Measure and inspect local constraints.** Check rootless volume
  ownership, SELinux, port mapping, resource use, readiness ordering, and signal
  handling. Demonstrate a cached offline stub/local-model path.
- [ ] **P1-06 — Record the architecture decision.** Add the next unused ADR after
  checking current numbering. Specify approved versions, persistence, application
  boundaries, rollout scope, and the reasons for full replacement.
- [ ] **P1-GATE:** Reproducible Linux rootless restart evidence passes the P0
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
does not change the production engine; P3 remains gated by P2-GATE.

- [ ] **P2-01 — Define run submission and identity.** Specify repository/branch,
  run, task, logical attempt, operation, and manifest digest identities. Snapshot
  resolved contracts, harness selection, configuration, and definition versions.
  Deduplicate retried submissions and reject incompatible snapshots.
- [ ] **P2-02 — Define service/control models.** Specify status queries, task
  selection, pause/resume/stop, cancellation, task replay, approvals, and request
  acknowledgement. Separate requested, accepted, applied, and rejected controls.
  Acknowledgement must not imply a harness process has already stopped.
- [ ] **P2-03 — Separate execution utilities.** Reuse harness adapters, request
  construction, task context, output/no-op checks, structured results, validation,
  artifact projection, and workspace utilities through narrow interfaces.
  Preserve existing utility tests and baseline legacy behavior during extraction.
- [ ] **P2-04 — Define storage/checkpoint contracts.** Specify immutable artifact
  references/digests, receipt state transitions, repository fencing, checkpoint
  publication, integrity checks, schema versions, and retention. Keep application
  records separate from Dapr internals.
- [ ] **P2-05 — Build the conformance matrix.** Turn P0 dispositions into fixtures
  and expected outcomes covering the cases listed in the release matrix below.
  Reuse the current test runner rather than introducing a parallel test framework.
- [ ] **P2-06 — Choose package and deployment ownership.** Record where the
  service, reusable execution library, container resources, and launcher client
  live; define bundling/bootstrap responsibilities before scaffolding packages.
  Target repositories should not install a second scheduler accidentally.
- [ ] **P2-GATE:** Contracts are reviewed and versioned; extracted utilities
  retain passing tests; all intentional behavior changes have migration notes.

**Starting points:** workflow engine `request.ts`, `task-context.ts`,
`task-execution.ts`, `task-result.ts`, `verify.ts`, `artifacts.ts`, `sandbox.ts`,
`commit.ts`, and `harness/`; execution adapter `scripts/adapter.ts`.

## P3 — Implement durable task effects and fenced integration

**Deliverables:** recoverable execution activities, storage adapters, and one
repository integration authority.

- [ ] **P3-01 — Persist operation receipts.** Support claimed, executing,
  effect-published, accepted, and failed/ambiguous outcomes with compare-and-set
  transitions. Redelivery reuses the logical attempt key; deliberate retries and
  task replay allocate new identities. Reconcile incomplete receipts after crashes.
- [ ] **P3-02 — Publish artifacts and checkpoints.** Persist content and integrity
  metadata before reporting activity success. Capture base revision, resulting
  changes including new/deleted/binary files, required Git objects, validation
  evidence, and toolchain/dependency metadata. Missing/corrupt objects fail closed.
- [ ] **P3-03 — Reconstruct isolated workspaces.** Prepare clean clones/worktrees
  from explicit checkpoints, verify paths and digests, apply the dirty-tree policy,
  and provision dependencies/credentials narrowly. Resume never requires the old
  worker's uncommitted files.
- [ ] **P3-04 — Fence repository integration.** Allocate increasing ownership
  tokens per repository/target branch. Enforce the token at the actual mutation
  boundary so expired workers cannot write directly; a pre-write TTL check alone
  is insufficient. Check expected heads, serialize integration, and surface conflicts.
- [ ] **P3-05 — Reconcile Git effects.** Detect an already integrated change after
  a crash before receipt persistence; avoid duplicate commits. Preserve audit
  references. Apply P0's explicit no-auto-commit/commit-failure policy without
  marking an uncheckpointed effect recoverable.
- [ ] **P3-06 — Enforce process lifecycle and isolation.** Propagate timeout and
  cancellation to owned harness subprocesses, handle worker loss, and reject
  late/stale outcomes. Avoid host-home mounts and engine sockets; document the
  separately approved approach for target builds requiring containers.
- [ ] **P3-GATE:** Redelivered activities produce one accepted effect set;
  stale owners cannot mutate the target branch; checkpoints reconstruct a task
  workspace; ambiguous integration is visible and blocks unsafe continuation.

## P4 — Complete the local Dapr workflow vertical slice

**Deliverables:** the replacement DAG workflow, durable controls, and a real
local task chain running through the same contracts as the old engine.

- [ ] **P4-01 — Implement deterministic orchestration.** Evaluate snapshot task
  readiness, phase dependencies, selected scope, skipped tasks, owner exclusivity,
  and bounded execution. Use durable timers/events for retry delays and waits;
  keep I/O, random identities, and wall-clock decisions in activities or approved
  deterministic runtime facilities.
- [ ] **P4-02 — Integrate verification and handoffs.** A successful harness exit
  is insufficient: require expected outputs, no-op policy, structured outcomes,
  mandatory validation, and compact predecessor artifacts before accepting work.
- [ ] **P4-03 — Implement durable controls and approvals.** Deduplicate requests,
  authorize operators, bind approvals to run/task and manifest/evidence digests,
  and reject stale attestations. Honor the agreed pause/stop/cancel distinctions.
- [ ] **P4-04 — Expose status and audit.** Provide authoritative run/task/attempt
  queries, sequenced lifecycle records, and reconnectable notifications.
  Compatibility file exports are read-only, rebuildable views, never control input.
- [ ] **P4-05 — Prove representative execution.** Complete a stub dependency chain,
  verification failure/retry, manual selection, parallel isolated tasks, and an
  approval wait. Then execute one real harness using scoped credentials and
  inspect integrated changes and validation evidence.
- [ ] **P4-06 — Bound histories and concurrency.** Measure large manifests,
  long waits, retry storms, and artifact/reference limits. Decide history rollover
  or child-workflow strategies only where supported, preserving task identity and
  evidence; apply backpressure and configurable worker limits.
- [ ] **P4-GATE:** Representative manifests meet the conformance matrix locally
  and resume after interruption without manual state edits.

## P5 — Migrate the launcher, Console, and local lifecycle

**Deliverables:** one service-backed user path and a managed local deployment.

- [ ] **P5-01 — Package the local stack.** Supply pinned images/configuration,
  persistent-volume ownership, readiness checks, restart policy, and resource
  limits. A container recreation must not reset durable data.
- [ ] **P5-02 — Add lifecycle management.** Implement launcher start/status/stop,
  diagnostics, backup/restore, and compatible upgrade operations. Make reset a
  separate confirmed destructive action. These are proposed capabilities, not
  existing command names; finalize their CLI surface in the compatibility matrix.
- [ ] **P5-03 — Migrate execution entry points.** Update engine-run, resume,
  launcher flow, wrappers, bootstrap/package resources, and auto-build polling
  to submit/query/control the service. Select local versus hosted deployment,
  not legacy versus Dapr scheduling.
- [ ] **P5-04 — Migrate Console/Board controls.** Replace file/PID control with
  authenticated service requests and acknowledged outcomes; reconnect from
  sequenced status/events. Remove scheduling dependence on dynamically importing
  the legacy engine while retaining shared readiness semantics.
- [ ] **P5-05 — Harden local access.** Expose Forge API/Console only on loopback
  by default; authenticate controls, validate browser origins/CSRF protections,
  constrain repository paths, scope secrets, and redact logs. Sidecar/store APIs
  remain private and inaccessible to untrusted task processes where feasible.
- [ ] **P5-06 — Preserve diagnostics and onboarding.** Show useful errors for
  unavailable Podman, missing VM/resources, credentials, corrupt volumes, and
  version mismatches. Export compatible status/audit views and document offline
  preparation, migration warnings, and disabled/retired flags.
- [ ] **P5-GATE:** A fresh local user can start the stack, submit and monitor a
  run, approve/control it, stop/restart, and recover through launcher and Console
  without editing generated files or using infrastructure APIs.

**Starting points:** `scripts/forge-launcher/scripts/engine-run.ts`, `resume.ts`,
`bootstrap.ts`, `launcher.ts`, `stage-resources.mjs`, and
`console/{control,jobs,paths,repo,server}.ts`; workflow-engine and auto-build skills.

## P6 — Qualify recovery, security, upgrades, and platforms

**Deliverables:** automated failure-injection coverage, operational runbooks,
support matrix, and release evidence.

- [ ] **P6-01 — Exercise failure boundaries.** Kill application/sidecar/worker
  during execution, retry delay, approval wait, checkpoint publication,
  integration, and receipt persistence. Duplicate deliveries/controls; expire
  ownership, introduce store outages, and deliver late task results.
- [ ] **P6-02 — Test backup and restore.** Quiesce or otherwise coordinate snapshots
  of workflow database, application receipts, Scheduler, artifacts, and Git refs.
  Restore into a fresh installation and check integrity and pending timers.
  Missing/out-of-sync stores must not silently accept incomplete tasks.
- [ ] **P6-03 — Test workflow/application upgrades.** Version definitions and
  activity contracts; drain incompatible runs or retain compatible workers.
  Verify historical replay, schema upgrades, and documented rollback constraints.
- [ ] **P6-04 — Review security boundaries.** Test unauthorized/stale approvals,
  cross-repository access, escaping paths/symlinks, log/secret exposure, malicious
  artifact metadata, and exhausted resource limits. Scan dependencies and changed
  code; require resolution of relevant findings before cutover.
- [ ] **P6-05 — Qualify supported platforms/harnesses.** Validate Linux rootless
  behavior and each claimed harness. Test Podman-machine networking, credentials,
  mounts, path translation, watchers, and performance separately on macOS/Windows.
  If desktop platforms are deferred, explicitly release as Linux-only.
- [ ] **P6-06 — Re-run parity and budgets.** Compare accepted outcomes, commit
  behavior, validation, audit, and controls with P0 fixtures; measure startup,
  memory/disk, long histories, cancellation, and recovery against agreed thresholds.
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
  compatible workflow/activity definitions.
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
files, and review security-sensitive boundaries before merging. This planning-only
change does not alter runtime behavior or imply a new release.

## Immediate next work package

P1-06 is recorded in [ADR-066](docs/adr/066-dapr-workflow-full-replacement-architecture.md).
The P2-01, P2-02, P2-04, and P2-06 contract deliverables are authored. P2-03
is tracked in [issue #4](https://github.com/McFuzzySquirrel/my-forge/issues/4):
extract and stage the Dapr-independent utilities while preserving the legacy
engine caller. Then build P2-05 conformance fixtures before requesting P2-GATE.
Console migration and legacy-engine retirement remain gated by their later
phases.

## P0 evidence — 2026-10-13

This section records preparation and the operator's explicit P0-GATE decision,
not release qualification. On 2026-10-13, the operator accepted P0-01/P0-02,
the compatibility register, and proposed budgets, then approved P0-GATE and
authorized the isolated P1 spike. The agent does not generate the human-review
JSON file. Checkboxes above remain unchecked until their deliverables and
acceptance evidence are merged. Baseline work ran against the existing engine
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

### Compatibility register — proposed, not yet accepted

All current production commands and settings remain unchanged in P0/P1.
These dispositions describe the future replacement, subject to P0 review.

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
