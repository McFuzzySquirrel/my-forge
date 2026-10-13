# Dapr Execution Contract v1

**Status:** P2 design baseline; implementation and P2-GATE review are pending.  
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

Configuration needed to reproduce execution is snapshotted. Credentials and
other secrets remain external; the snapshot records only a secret reference and
version where the provider supports it. Host-specific values such as `PATH`,
`PWD`, absolute binary paths, and the raw repository URL are not portable run
identity and must be resolved by the approved worker environment.

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
  without authenticated operator identity is not approval.
- Effective task selection and dependency expansion are immutable for an
  accepted run. Updating selection requires a documented new snapshot/run
  behavior, not mutation of accepted submission data.

## 3. Receipts, artifacts, checkpoints, and fencing

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

### Checkpoints

A checkpoint is immutable and includes its schema version, run ID, manifest
digest, parent checkpoint digest when present, published artifact references,
workspace/Git tree identity, and integrity metadata. A checkpoint is visible to
recovery only after all referenced data is durably written and verified. A
workflow may publish a reference only after the application receipt confirms
publication.

Retention may remove terminal diagnostics only after the retention policy
expires and no live workflow, checkpoint, approval, or review references them.
There is no automatic deletion of live references. Missing or digest-mismatched
data blocks recovery explicitly; it is not treated as an empty successful
checkpoint.

### Repository fencing

Integration ownership is scoped to `(repositoryId, targetRef)`. A lease grant
has a service-issued monotonically increasing `fencingToken`, owner run ID,
expiry, and revision. Every repository mutation and acceptance must present the
current token; a stale owner cannot publish an accepted integration result
after a newer token is issued. Workflow actor placement is not a substitute
for this repository fence.

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

## 6. Compatibility and exclusions

P2 preserves current production behavior while extraction proceeds. It does not
authorize writes by the future service, launcher/Console migration, unauthenticated
approval, cross-host failover, Dapr retry/cancellation claims, or automatic
legacy-history import. The P0 compatibility register remains a proposed
replacement mapping until its implementation and later migration gates pass.
