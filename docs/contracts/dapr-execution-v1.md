# Dapr Execution Contract v1

**Status:** P2-GATE and P3-GATE accepted; P4-01 deterministic orchestration and
local timer/event recovery are complete using test-only activities. P4-02
verification and handoff integration is in review under
[issue #9](https://github.com/McFuzzySquirrel/my-forge/issues/9) and
[PR #10](https://github.com/McFuzzySquirrel/my-forge/pull/10). P4-03 onward and
production service qualification remain pending.
**Owner:** [Dapr execution boundary feature](../features/dapr-execution-boundary.md).  
**Architecture:** [ADR-066](../adr/066-dapr-workflow-full-replacement-architecture.md).

This document defines the versioned application contract used by the future
execution service and its launcher client. It is not a Dapr wire contract, a
manifest replacement, or authorization to change the current engine. All
records carry `schemaVersion: 1`; unknown major versions are rejected rather
than interpreted as v1.

## 1. Run submission and identity

### Submission

A `RunSubmissionV1` contains:

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `submissionKey` | Caller-generated UUID identifying one intended submission; reused for transport retries only |
| `repositoryId` | Stable service-owned identifier for the repository |
| `targetRef` | Exact target branch/ref; never inferred from a later working tree |
| `manifestSnapshot` | Immutable resolved execution manifest and requirement/task contract snapshot |
| `manifestDigest` | `sha256:` plus the lowercase SHA-256 digest of the snapshot's RFC 8785 canonical JSON bytes |
| `selection` | Requested mode and task IDs, plus the dependency-expanded effective task IDs frozen by the service |
| `harness` | Harness identifier and adapter definition version |
| `configuration` | Non-secret resolved settings plus external secret reference/version identifiers; never secret values |
| `workflowDefinitionVersion` | Exact workflow implementation version used to interpret this run |

The service computes and verifies `manifestDigest`; a caller-provided mismatch
is rejected. It stores the snapshot before accepting a run. A `submissionKey`
is unique within `repositoryId`: an identical canonical request returns the
original `runId`, while reuse with a different snapshot or target is rejected
as a conflict. A deliberate new run uses a new key.

The workflow graph in `manifestSnapshot` preserves phase order and phase
dependencies. Each task includes its stable `id`, optional direct
`dependencies`, and optional `ownerAgent`. All tasks without an `ownerAgent`
share one exclusivity group; tasks with the same owner are not dispatched in
parallel. A phase prerequisite includes every task in each prerequisite phase.
The dispatcher selects ready tasks in manifest order, up to the snapshotted
`configuration.settings.concurrency` limit (default `1`). Both `complete` and
`skipped` prerequisites satisfy readiness. Retry settings are
`maxRetries` (default `2`) and `retryDelayMs` (default `5000`); an explicit
retryable task failure starts a new logical attempt after a Dapr durable timer.
An activity exception is terminal for that task attempt because an external
effect may be ambiguous; it is not retried as a new operation.
An activity may return a wait request; the task workflow then waits on the
durable `task-control` external event and passes only its UUID `controlId` to
the `resumeTask` activity. The event is raised on the deterministic
task-attempt workflow instance, not the parent run instance. The event is a
wake-up signal, not an approval:
`resumeTask` must validate authorization, run/task binding, and current evidence
before accepting any control.

Configuration needed to reproduce execution is snapshotted. Credentials and
other secrets remain external; the snapshot records only a secret reference and
version where the provider supports it. Host-specific values such as `PATH`,
`PWD`, absolute binary paths, and the raw repository URL are not portable run
identity and must be resolved by the approved worker environment.

The manifest snapshot includes the resolved task contracts, expected output
paths, validation commands, artifact input/output types, and task/phase
dependencies. `configuration.settings.allowNoop` is a snapshotted boolean that
defaults to `false`; it bypasses only the no-op heuristic when no expected
outputs are declared.

### Stable identities

| Identity | Contract |
|---|---|
| `repositoryId` | Service-owned stable repository identity; sensitive remote URLs are not exposed as identifiers |
| `runId` | Service-generated immutable identifier; maps to one workflow instance but does not expose Dapr's internal history format |
| `taskId` | Stable task identifier from the immutable manifest snapshot |
| `logicalAttempt` | Positive integer scoped to a `(runId, taskId)`; starts at 1 and increments only for an explicit retry/replay |
| `operationId` | Stable UUID for one logical side effect; activity redelivery reuses it, a deliberate new operation does not |
| `manifestDigest` | Content identity of the immutable manifest/contract snapshot |
| `controlId` | Caller-generated UUID deduplicating retries of one control request |

`manifestDigest` covers only `manifestSnapshot`. The service also derives a
`snapshotDigest` from the canonical submission excluding `submissionKey` and
the service-frozen `effectiveTaskIds`: repository, target ref, manifest digest,
requested selection, harness, configuration, and workflow definition version.
Submission-key deduplication compares this digest. Reconciliation or
source edits create a new snapshot and an explicit new run; they never mutate
an in-flight run.

## 2. Status and control

Run statuses are `queued`, `running`, `pausing`, `paused`, `stopping`,
`cancelling`, `complete`, `failed`, and `cancelled`. Task statuses are
`pending`, `ready`, `running`, `waiting-for-approval`, `complete`, `failed`,
`skipped`, and `cancelled`. Status responses include the run/snapshot identity,
observation time, and a monotonically increasing service revision so clients
can detect stale reads.

Controls are `select-tasks`, `pause`, `resume`, `stop`, `cancel`, `replay-task`,
and `approve-task`. Each request contains a `controlId`, `runId`, action, and
action-specific payload. A repeated `controlId` with the same payload returns
the same control record; reuse with a different payload is a conflict.
Control payloads are limited to 64 KiB of UTF-8 JSON before persistence.

Control records advance through `requested`, `accepted`, then either `applied`
or `rejected`. Rejection includes a stable reason code. `accepted` means the
service durably recorded and scheduled the request; it does not mean a running
harness process has stopped or an external effect has completed. Status and
control queries are the source for later application.

- `pause` stops scheduling new tasks and lets already-dispatched activities
  reach a recorded boundary.
- `stop` has the same resumable, nonterminal meaning as the existing graceful
  stop: stop dispatching after the current task boundary and leave the run
  resumable. It is not process termination.
- `cancel` is distinct and terminal. It requests owned-process cleanup, rejects
  late results, and preserves diagnostics. Dapr workflow termination alone is
  not evidence that a harness process stopped.
- `replay-task` creates a new `logicalAttempt`; it never rewrites an accepted
  prior attempt or reuses its side-effect operation IDs.
- `approve-task` is operator-only and binds the decision to the run snapshot,
  task identity, and immutable evidence digests. `--yes` or a control request
  without authenticated operator identity is not approval. The trusted service
  adapter supplies the principal subject and roles; these claims must never
  come from the control payload or a CLI confirmation flag. The approval also
  records the current logical attempt. Authorization requires the task to be
  waiting for approval and the offered evidence digest set to match the current
  attempt exactly; a delayed approval for an older attempt is not reusable.
- Effective task selection and dependency expansion are immutable for an
  accepted run. Updating selection requires a documented new snapshot/run
  behavior, not mutation of accepted submission data.

The provider-neutral `TrustedPrincipalV1` contract is an input from an
authenticated adapter, not an authentication mechanism. `authorizeTaskApproval`
checks the subject, operator role, current task state, attempt, and evidence
binding. The binding also persists the deterministic task-workflow instance ID
for that logical attempt so a replayed task cannot receive an approval event
intended for an older workflow instance.

`PostgresControlRecordStore` durably records idempotent requests and
compare-and-set state transitions, with the approval binding stored on the
accepted control before event delivery and retained on the applied control.
`TaskApprovalCoordinator` raises only the control ID to that task workflow;
`createResumeTaskActivity` calls `resolveApprovalWake` before invoking the
host's idempotent resume handler, then marks the control applied. The
`RunControlCoordinator` validates run/task state and raises only the control ID
to the deterministic run workflow identified by `runOrchestrationWorkflowId`.
Set `controlsEnabled: true` on the run
workflow input and register the control activities to enable the run-control
event path. Pause/stop are applied at a safe boundary and wait for resume;
cancel remains accepted until the host adapter confirms owned-process cleanup
and late-result fencing; replay obtains a durable next logical attempt from
the host adapter. The host must implement these effect adapters idempotently
by `controlId`, resolve current context from authoritative run state, provide
an authenticated `TrustedPrincipalV1`, and never expose the store to callers.
This package supplies reusable boundaries; it does not implement a network
identity provider or a production service host.

## 3. Receipts, artifacts, checkpoints, and fencing

### Task result admission and handoffs

A settled harness exit is not task completion. The Dapr-independent activity
adapter uses `admitTaskResult` from `tools/dapr-engine/execution/` to apply all
completion gates before returning `status: "complete"`:

1. The harness must exit successfully.
2. Every declared expected output must resolve to a repository-local regular
   file. `allowNoop` never bypasses this check.
3. The harness must return one valid fenced `forge-result` report. Its
   `unresolved` list must be empty; a nonempty list is a blocking requirement
   failure.
4. When no expected outputs are declared, the no-op policy requires either
   changed files or a substantive structured summary unless the snapshotted
   `allowNoop` setting is true.
5. Every validation command in the immutable task manifest is executed from the
   task repository root, and every command must exit zero. Agent-reported test
   names are not execution evidence.

Verification failures are returned as classified task failures and follow the
configured bounded retry policy. An activity exception remains terminal because
an external effect may be ambiguous; it is not converted into a successful
verification result. Failed admission outcomes retain their gate statuses and
bounded reason in the activity result; validation diagnostics are capped at
4,000 characters before they enter workflow history.

For a task with declared `inputs`, the activity projects only complete artifacts
of those types that were produced by its dependency-ready predecessor tasks.
It selects the latest artifact per predecessor/type and copies only the
configured compact fields; it does not forward an entire artifact payload,
conversation, or artifact from an unrelated task. If a declared input type has
no successful predecessor artifact, task preparation fails rather than silently
running without required context. Projection is built by
`ArtifactStore.projectPredecessors`; reference/integrity verification remains
the responsibility of the artifact store that resolves those references.

Every successful activity returns `TaskCompletionEvidenceV1`, bound to the run,
task, manifest digest, logical attempt, and operation ID. It carries a canonical
completion digest, the structured handoff digest, output-file list, published
artifact references, and passed evidence for the harness, outputs, handoff,
requirements, and validation gates. A task workflow rejects a `complete`
outcome without this evidence or with a mismatched identity/digest; the parent
orchestrator repeats the run/task/manifest binding check before scheduling
dependents. The digest detects malformed or inconsistent evidence, but is not an
authentication mechanism and does not prove that an activity implemented the
checks correctly.

### Operation receipts

Application-owned receipts are keyed by
`(runId, taskId, logicalAttempt, operationId)` and have a schema version,
monotonic `recordVersion`, timestamps, and bounded diagnostic references.
Transitions use compare-and-set on `recordVersion`:

```text
claimed -> executing -> effect-published -> accepted
                    \-> failed
                    \-> ambiguous -> accepted | failed
```

An activity delivery reuses the same logical operation key. A receipt marked
`ambiguous` cannot be silently retried as a new paid or repository-mutating
effect; reconciliation must establish whether the effect was published before
advancing it. Invalid transitions and stale revisions are explicit conflicts.
These records are application-owned and never stored by mutating Dapr workflow
history.

The PostgreSQL adapter in `tools/dapr-engine/storage/postgres/` stores receipts
under the four-part operation key. Apply
[`operation-receipts.sql`](../../tools/dapr-engine/storage/postgres/operation-receipts.sql)
before using the adapter. Claims are idempotent, transitions compare both the
expected record version and current state in the update, and
`listReconciliationCandidates` exposes bounded batches of nonterminal receipts
for effect-specific recovery. It does not guess whether an interrupted external
effect occurred; a reconciler must establish that outcome before resolving an
`ambiguous` receipt. At most 32 diagnostic references of up to 2,048 characters
are retained per receipt.

### Immutable artifact references

`ArtifactRefV1` contains `schemaVersion`, opaque `artifactId`, immutable `uri`,
`mediaType`, `sizeBytes`, `sha256`, and optional sensitivity/retention metadata.
The service verifies the digest and size when publishing and resolving a
reference. Replacing content creates a new reference; it never overwrites bytes
under an accepted digest.

The P0 proposals of 32 MiB per production artifact and 256 KiB for bounded
metadata still require later qualification; this contract does not claim those
limits have been tested. Provider output, logs, secrets, and repository payloads
must not be copied into workflow history merely for convenience.

`FileArtifactCheckpointStore` in `tools/dapr-engine/storage/files/` persists
artifact bytes below an absolute, operator-configured storage root, separate
from PostgreSQL workflow/receipt state. Objects use
`artifact://sha256/<hex>` URIs and digest-derived paths. Publication verifies
declared size and digest, writes a mode-0600 temporary file, syncs it, links it
to the immutable content path without replacement, syncs the containing
directory, and verifies the stored bytes before returning success. Existing
content is never overwritten; missing, corrupt, or conflicting content fails
closed. The root must be backed by durable storage in deployment. Retention does
not delete stored objects automatically.

### Checkpoints

A checkpoint is immutable and includes its schema version, run ID, manifest
digest, parent checkpoint digest when present, published artifact references,
workspace/Git tree identity, and integrity metadata. A checkpoint is visible to
recovery only after all referenced data is durably written and verified. A
workflow may publish a reference only after the application receipt confirms
publication.

`TaskCheckpointV1` extends this record with the base commit revision; changed
paths and added/modified/deleted classification; binary status, blob IDs, and
Git modes; the complete required-object IDs and a Git object bundle reference;
validation-evidence references; toolchain name/version entries; and dependency
lockfile paths with immutable artifact references. Every referenced object,
including validation and lockfile artifacts, must also appear in the checkpoint
artifact list. The store rejects unsafe paths, incomplete change metadata, and
references that are missing or fail integrity checks. Checkpoint metadata is
stored as canonical JSON at a digest-derived path and reverified with every
recovery read.

`captureWorkspaceCheckpoint` in
`tools/dapr-engine/execution/workspace-reconstruction.ts` produces a task
checkpoint from a workspace. It stages the working tree (honouring
`.gitignore`) into a private index, so the workspace index, `HEAD`, and refs
are untouched. It commits that tree with the base revision as its only parent
and bundles the result commit's history from a scratch repository. It also
publishes the requested regular-file lockfiles and the checkpoint with its
computed changes and required-object inventory. The returned `resultCommit`
binds to the checkpoint, so it can be integrated with the base revision as the
expected head. With a fixed commit time, capturing the same tree again yields
the same commit.

Retention may remove terminal diagnostics only after the retention policy
expires and no live workflow, checkpoint, approval, or review references them.
There is no automatic deletion of live references. Missing or digest-mismatched
data blocks recovery explicitly; it is not treated as an empty successful
checkpoint.

### Workspace reconstruction

`CheckpointWorkspaceReconstructor` in
`tools/dapr-engine/execution/workspace-reconstruction.ts` requires an explicit
checkpoint digest and an operator-configured absolute scratch root. It imports
the checkpoint's Git bundle into a new repository with no remote; the bundle
must advertise a ref whose object closure contains all declared required Git
objects. It checks every declared object and all objects needed by the
base/result trees, then verifies the checkpoint's safe paths, change metadata,
modes, blob IDs, binary flags, dependency-lockfile bytes, and
workspace-contained symlink targets. The scratch root is restricted to owner
access. The base revision remains `HEAD`; the checkpoint tree is restored into
the working tree without staging it. Missing or corrupt checkpoint data,
unlisted Git objects, escaping symlinks, or mismatched metadata fails closed.

The dirty-tree policy is **checkpoint-only**: reconstruction never reads or
copies a worker's old checkout, a mounted repository, or its uncommitted files.
Each workspace starts from the named checkpoint and is disposable after the
next durable checkpoint is published. Dependencies are not inherited through
symlinks or a shared `node_modules`; optional dependency setup must be requested
and supplied by a trusted provisioner scoped to the new workspace and its
verified lockfiles.

Credential resolution is separate from workspace creation. A caller must bind
specific run secret references to explicit environment variable names; the
resolver receives only the repository, target ref, selected harness, and one
bound reference at a time. Reserved process and Git configuration variables
are rejected. Resolved values are returned for the selected harness process
only and must not be written into the workspace, checkpoint, or logs. The
implementation provides no credential backend or automatic dependency
installer.

### Repository fencing

Integration ownership is scoped to `(repositoryId, targetRef)`. A lease grant
has a service-issued monotonically increasing `fencingToken`, owner run ID,
expiry, and revision. Every repository mutation and acceptance must present the
current token; a stale owner cannot publish an accepted integration result
after a newer token is issued. Workflow actor placement is not a substitute
for this repository fence.

Lease grants and integrations serialize on the durable fence row for that
scope. The integration authority rechecks owner, token, and expiry while holding
that row lock, then keeps it through the target-ref mutation and integration
record commit; a competing lease grant cannot advance the token during that
critical section. Workflow workers operate on isolated workspaces and do not
receive writable access to the target repository. The authority updates only a
fully qualified branch ref, using Git's atomic expected-old-object check; a
moved or deleted head returns `expected-head-mismatch` without changing the
branch. A bounded ref-update window keeps the lease live through the mutation.
If Git may have changed the ref but its result or the durable integration record
cannot be confirmed, the outcome is ambiguous and must be reconciled before
continuation.

### Git effect reconciliation

An integration request names a `checkpointDigest`. Before any mutation, the
authority re-verifies that checkpoint, requires it to belong to the run, and
requires the commit's first parent to be the expected head and its tree to be
the checkpoint's `gitTreeId`. An integration therefore never publishes branch
content that is not recoverable from a verified checkpoint.

Integration then runs in two fenced transactions. The first records a durable
`pending` intent (commit, expected head, checkpoint, token, operation) for the
logical attempt; the second performs the Git expected-head update and writes the
integration record, marking the intent `integrated`. A head mismatch marks the
intent `abandoned`. Integration records are unique per attempt and per
`(repository, targetRef, commit)`, and record whether the `authority` or
`reconciliation` wrote them so the audit trail distinguishes observed effects
from recovered ones.

A redelivered integration whose commit is already reachable from the target
branch, but whose record is missing because the process died after the ref
update, records the existing effect and returns it as reused instead of
reporting a head mismatch or creating a second commit.

`reconcile(scope)` establishes the outcome for one attempt under the fence lock:

| Durable state | Git state | Result |
|---|---|---|
| Integration record exists | — | `integrated` (checkpoint re-verified) |
| Pending intent, checkpoint verified and bound | Commit reachable from branch | Backfill record as `reconciliation`; `integrated` |
| Pending intent | Commit not reachable | Abandon intent; `not-integrated` |
| No intent | — | Write an abandoned tombstone; `not-integrated` |
| Checkpoint missing/corrupt or commit not bound to it | — | `blocked`; never accepted; a pending intent stays pending |
| Different operation or commit already claimed by another attempt | — | `blocked` |

Git read failures throw and leave state unchanged. A blocked backfill records
nothing, because the pending intent already holds the audit data.

**Unresolved integrations block the branch.** At most one intent can be pending
per `(repository, targetRef)`, because intents are inserted only while holding
the fence row lock. While one attempt's intent is pending, whether in flight,
lost, or ambiguous, `integrate` for any other attempt on that branch returns
`unresolved-integration` with the blocking attempt and changes nothing. This
stops later work from building on an effect that may never be accepted. The
block clears only when the attempt completes or `reconcile` resolves it. An
operator clears a `blocked` reconciliation by restoring the checkpoint data and
reconciling again, or by moving the branch so that the commit is unreachable and
reconciling to `not-integrated`. Reconcile another attempt only after its
execution is lost (heartbeat expired and fenced) or its receipt is `ambiguous`.
A pending intent alone may belong to a live owner between its two transactions.

Because an abandoned intent
is checked inside the same fenced transaction as the mutation, a worker that
outlives reconciliation cannot integrate that logical attempt later; a retry
allocates a new logical attempt. `reconcileIntegrationReceipt` applies the
result to the operation receipt: `integrated` advances it to `accepted` under
`gitIntegrationEffectDigest` of the effect; `not-integrated` marks it `failed`;
`blocked`, or an effect digest conflict, leaves or moves it to `ambiguous`,
which blocks continuation. Each resolution appends a `git-integration:*`
diagnostic reference.

`resolveGitEffectPolicy` encodes the P0 auto-commit register. Disabled
auto-commit, "nothing to commit", and a failed local commit (warning
`commit-failed`, preserving the legacy non-fatal behavior) accept only a
verified checkpoint as the recoverable effect. Without a verified checkpoint the
attempt fails as `uncheckpointed-effect`. A created commit must be integrated to
be accepted; a rejected integration fails and an ambiguous one, or an integrated
commit whose checkpoint is unavailable, stays `ambiguous`.

### Process lifecycle and isolation

An `executing` receipt has at most one live **execution owner**, recorded per
operation key with a monotonically increasing `executionEpoch`, the owning
`workerId`, a heartbeat expiry, and a fixed `deadlineAt`. The first start sets
the deadline from the attempt budget; a redelivered activity can take over only
after the previous owner's heartbeat expires, receives `epoch + 1`, and keeps
the original deadline, so worker loss never extends an attempt. Takeover after
the deadline, of a cancel-requested execution, or of a receipt that is no
longer `executing` is rejected, and a published outcome is never relaunched.
Epochs that expired while running are recorded as lost. Heartbeats, exit
reports, and outcome publication carry the `(executionEpoch, workerId)` claim;
a superseded or expired claim is rejected as `stale-execution` or
`execution-expired` and never changes the receipt. All times use the
authority's (database) clock.

The worker supervisor (`superviseExecution` in
`tools/dapr-engine/execution/process-lifecycle.ts`) owns one abort signal per
execution. It is aborted by the deadline, by the caller's cancellation, by a
heartbeat directive after a durable `cancel` request, and by heartbeat
rejection or a store outage longer than the heartbeat TTL (`ownership-lost`).
The harness runner kills the whole POSIX process group on abort and, for an
isolated request, also reaps descendants left in the group after a normal
exit. Exit is recorded only after the process has settled, with
`processCleanup` `observed` or `unconfirmed`; Windows tree cleanup is reported
as `unconfirmed`. An owner that lost ownership does not report an exit.
Accepting `cancel` is therefore distinct from the process being stopped.

Outcome admission (`decideOutcomeAdmission`) and the receipt transition happen
in one transaction (`PostgresExecutionOwnershipStore.publishOutcome`):

| Execution state | Effect (`effect-published`) | Failure (`failed`) |
|---|---|---|
| Still running | `process-running` | `process-running` |
| Cancel requested | `late-result`; receipt fails with preserved diagnostics | `late-result`; receipt fails |
| Exited, cleanup `unconfirmed` | `cleanup-unconfirmed` | Admitted |
| Exited after cancel or past the deadline | `late-result` / `deadline-exceeded` | Admitted |
| Exited cleanly before the deadline | Admitted | Admitted |

`fenceLostExecutions` marks running owners with expired heartbeats `lost`; a
lost cancel-requested execution fails its `executing` receipt with
`execution:cancelled-worker-lost:epoch-N:cleanup-unconfirmed`. Other lost
executions stay available for takeover. The table
(`storage/postgres/operation-executions.sql`) references operation receipts and
is applied after `operation-receipts.sql`.

**Worker death.** On POSIX, an isolated harness runs under a process-group
watchdog (`runCommand` with `reapProcessGroupOnExit`). The watchdog is a
small Node process that leads the harness's process group, launches the
harness inside it, and holds an IPC channel to the worker. It stays alive after
the harness exits until the worker reaps the group. When the worker dies at any
point (crash, `SIGKILL`, OOM, including between harness exit and reaping), the
kernel closes the channel and the watchdog kills its whole group. It also kills
the group at a hard deadline (invocation timeout plus a 1 s cleanup grace), so
an unresponsive worker cannot extend the tree. This holds on a bare host and in
a container; a container PID namespace additionally ends everything with the
worker container.

Two cases are outside the process-group primitive and are left to the
deployment's containment (the worker container's PID namespace, or a service
manager that kills the worker's whole cgroup, such as systemd
`KillMode=control-group`). These are a descendant that leaves the group itself
(`setsid`/`setpgid` daemonizing) and the watchdog being killed at the same
moment as the worker. In every case, fencing rejects the orphan's late results.
Windows has no process-group watchdog. Tree cleanup is reported as
`unconfirmed`, which blocks effect publication (fail-closed). A takeover reruns
the harness from the reconstructed workspace, so a provider call may be repeated
but its effect is accepted at most once.

**Isolation.** An isolated attempt receives a private, `0700` scratch home with
its own XDG and temporary directories, never inside the host home, and a
complete allowlisted environment instead of the worker's: only locale, path,
terminal, certificate, proxy, and required Windows system variables pass
through, plus explicitly granted harness credentials. Engine endpoints
(`DOCKER_*`, `CONTAINER_HOST`, `PODMAN_*`, `BUILDKIT_*`, `CONTAINERD_*`,
`KUBECONFIG`), Dapr and service API tokens, SSH agent, D-Bus, display, database
credentials, loader/Node injection, and Git overrides are never inherited and
cannot be granted as credentials. `checkContainerIsolation` rejects worker or
harness container specs with relative bind sources, host-home binds, engine
socket binds, privileged mode, host PID namespace, or engine endpoint
variables.

**Target builds that require containers.** A harness never receives the host
or worker container engine socket, so a target repository whose verification
builds or runs containers cannot do so through the worker. Supporting such
targets is a separately approved capability: an operator must explicitly enable
a dedicated rootless builder or remote build service with its own storage and
credentials, scoped to the run, that is not the engine running the worker or
service. Until that approval and its design exist, such verification fails as a
configuration error rather than falling back to a host engine.

## 4. Package and deployment ownership

- `tools/dapr-engine/` owns the future workflow service and executable entry
  points.
- `tools/dapr-engine/execution/` owns reusable task/harness/verification and
  workspace utilities. Its exported interfaces must not import Dapr SDK types
  or the legacy scheduler state machine; Dapr activities adapt to these
  interfaces.
- `tools/dapr-engine/deploy/` owns versioned container and local/hosted
  deployment resources. Workflow history, Scheduler persistence, and artifact
  storage remain distinct configured resources.
- `scripts/forge-launcher/` owns the client and release packaging/deployment
  entry points. The launcher release stages the service runtime/resources into
  its own managed distribution after the build/bootstrap responsibilities are
  implemented.
- Launcher bootstrap stages the canonical Dapr-independent execution library
  inside the `forge-workflow-engine` skill so its preserved legacy call paths
  remain runnable. It must not copy or install the Dapr workflow service or a
  second scheduler in every target repository.

These are source ownership decisions, not a claim that production service
entry points or deployment commands already exist. The P2-03 utility library
is the only implementation staged by the legacy skill bootstrap.

## 5. Conformance matrix

The following outcomes are normative. Each case has a stable ID and a runnable
fixture discovered by `npm test --prefix tools/dapr-engine`; `matrix.test.ts`
fails if a listed case lacks a fixture in its named file or a fixture cites an
unlisted case. Fixture files live in `tools/dapr-engine/tests/conformance/`.

| ID | Case | Expected outcome | Fixture |
|---|---|---|---|
| C01 | Same repository, submission key, and canonical snapshot retried | Return the same `runId`; create no second workflow | `identity.test.ts` |
| C02 | Submission key reused with changed branch, digest, selection, harness, or definition version | Reject as conflict; preserve the accepted snapshot | `identity.test.ts` |
| C03 | Caller sends an incorrect manifest digest | Reject before run acceptance | `identity.test.ts` |
| C04 | Secret value appears in a persisted submission snapshot | Reject or redact before persistence; never return it in status | `identity.test.ts` |
| C05 | Duplicate `controlId` and identical payload | Return the original control result | `controls.test.ts` |
| C06 | Same `controlId` with a different payload | Reject as conflict | `controls.test.ts` |
| C07 | Pause/stop accepted while an activity is running | Report accepted separately from process exit; do not dispatch the next task before the boundary | `controls.test.ts` |
| C08 | Cancel races with a late activity result | Preserve diagnostics, reject late acceptance, and complete cleanup only when observed | `controls.test.ts` |
| C09 | Task replay requested | Allocate a larger logical attempt while retaining prior attempt and operation records | `controls.test.ts` |
| C10 | Unknown selected task or unresolved dependency | Reject the run before any task dispatch | `identity.test.ts` |
| C11 | Activity is redelivered with the same operation identity | Reuse the receipt; do not publish a conflicting accepted effect | `effects.test.ts` |
| C12 | Existing receipt revision is stale or transition is invalid | Reject compare-and-set explicitly | `effects.test.ts` |
| C13 | Artifact bytes do not match the declared digest/size | Reject publication or resolution; do not produce success-shaped empty output | `effects.test.ts` |
| C14 | Checkpoint references an unpublished or corrupt artifact | Keep checkpoint unavailable and report integrity failure | `effects.test.ts` |
| C15 | Repository integration presents an expired fencing token | Reject acceptance even if workflow status still reports the task running | `effects.test.ts` |
| C16 | Terminal diagnostic expires but a live checkpoint/review references it | Retain the referenced data | `effects.test.ts` |
| C17 | `approve-task` without authenticated operator identity, including `--yes`/confirmation flags | Reject with `operator-identity-required`; the task stays waiting | `controls.test.ts` |
| C18 | `approve-task` with evidence digests that differ from the current attempt | Reject with `stale-evidence`; an accepted approval binds run, manifest digest, task, evidence, and operator | `controls.test.ts` |
| C19 | Selection change requested for an accepted run | Freeze dependency-expanded selection; reject `select-tasks` with `selection-immutable` | `identity.test.ts` |
| C20 | Receipt became `ambiguous` | Never re-enter `executing`; redelivery reuses it and only reconciliation advances it to `accepted` or `failed` | `effects.test.ts` |
| C21 | Stale owner integrates after a newer fencing token, or one logical attempt integrates twice | Reject the stale token; accept one integration per logical attempt and reject a conflicting second result | `effects.test.ts` |
| C22 | Equivalent manifest snapshots with different key order | Produce the same RFC 8785 `sha256:` digest; reject non-JSON values | `identity.test.ts` |
| C23 | Process dies after the Git ref update but before the integration record or receipt | Reconciliation records the existing commit and accepts the receipt once; redelivery creates no second commit | `effects.test.ts` |
| C24 | Process dies before the ref update, or the attempt never recorded an intent | Reconciliation fails the receipt and abandons the attempt; a late integration is rejected | `effects.test.ts` |
| C25 | Auto-commit disabled, nothing to commit, local commit failure, or uncheckpointed effect | Accept only a verified checkpoint (commit failure as a warning); rejected integration fails; ambiguous or uncheckpointed integration stays ambiguous | `effects.test.ts` |
| C26 | Attempt deadline, durable cancel, a harness leaving background descendants, or a worker that is killed (mid-attempt or before reaping) or unresponsive | Kill the owned process tree (POSIX group) and record exit only after it settles, with cleanup `observed`; the watchdog kills the group on worker death or at the hard deadline | `lifecycle.test.ts` |
| C27 | Worker loss, then redelivery | Take over with the next epoch and original deadline only after the heartbeat expires; reject stale heartbeats, exits, and publications; never relaunch after publication or the deadline; stop a harness whose owner cannot renew | `lifecycle.test.ts` |
| C28 | Outcome reported while the process runs, after cancel, or with unconfirmed cleanup | Reject `process-running`; fail the receipt as `late-result` with preserved diagnostics; reject an effect with unconfirmed cleanup but admit a failure; fail a cancelled lost execution | `lifecycle.test.ts` |
| C29 | Harness environment, home, or container spec exposes host home, engine sockets, or service credentials | Strip forbidden variables and credentials, use a private non-host home, and reject host-home/socket binds, privileged mode, host PID, and engine endpoints | `lifecycle.test.ts` |
| C30 | Another attempt integrates while an earlier attempt's integration is pending or ambiguous | Reject `unresolved-integration` without changing the branch until reconciliation accepts or abandons the earlier attempt | `effects.test.ts` |
C10, C17, C18, and C19 pin intentional compatibility changes: the legacy engine
ignores unknown selected IDs, accepts a confirmation flag as review intent, and
lets reconciliation rewrite selection in place.

The fixtures run against an in-memory reference model
(`tests/conformance/support/reference-model.ts`) built on the Dapr-independent
primitives in `tools/dapr-engine/contract/v1/`. Passing them demonstrates the
specified semantics only. They are not durability, restart, Dapr, or
process-cleanup evidence; P3 storage/integration adapters must pass the same
cases before those claims are made. In the reference model, a graceful `stop`
settles to the resumable `paused` status at the task boundary.

C26 and C29 run real POSIX subprocesses through the harness runner; C27 and C28
use an in-memory execution store (`tests/conformance/support/execution-store.ts`)
built on the same ownership decisions as the PostgreSQL store, which is covered
by `tests/storage/postgres-operation-executions.integration.test.ts`. The
composed P3-GATE scenarios in `tests/storage/p3-gate.integration.test.ts` chain
checkpoint capture and reconstruction, the execution supervisor, worker-loss
fencing, and the integration authority against PostgreSQL and real Git. They
cover C23, C27, and C30 end to end.

## 6. Compatibility and exclusions

P2 preserves current production behavior while extraction proceeds. It does not
authorize writes by the future service, launcher/Console migration, unauthenticated
approval, cross-host failover, Dapr retry/cancellation claims, or automatic
legacy-history import. The P0 compatibility register remains a proposed
replacement mapping until its implementation and later migration gates pass.
