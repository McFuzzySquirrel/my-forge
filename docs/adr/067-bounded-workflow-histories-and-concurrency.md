# ADR-067: Bounded Workflow Histories and Concurrency

**Status:** Accepted  
**Date:** 2026-10-19

## Context

P4-06 requires the Dapr execution engine to stay bounded for large manifests,
long waits, retry storms, and large artifacts, while preserving task identity
and evidence. Before P4-06, a run workflow kept every task dispatch and control
wake in a single history. Settings had no upper bounds. Activity outcomes
entered history at whatever size the activity returned. Run starts were never
refused, whatever the worker's load.

The released Dapr JS SDK (3.18.0) has fixed worker constraints:

- It processes at most 10 work items at a time and queues 100 more. Neither
  value is configurable through the public API.
- Beyond the queue, it drops work items with only a warning.
- A completed `WhenAllTask` never notifies its parent composite task. As a
  result, `whenAny([whenAll(children), controlEvent])` never resolves through
  the wave. Every controls-enabled run therefore hung after its first wave.
  Earlier live verification ran with controls disabled and so never exercised
  this path.
- The `WhenAllTask` constructor resets its completed-child count after the base
  constructor has counted children that already finished. A `whenAll` built
  over a partly finished wave therefore never completes. In a live run this
  stalled about one in six controls-across-rollover runs, when a control woke
  the run mid-wave.

Dapr supports `continueAsNew`, and on Dapr 1.18.7 the measurement showed that
the old generation's history rows are discarded at each rollover. External
events raised during a rollover are not guaranteed to reach the new
generation.

## Decision

1. **Explicit limits (`RUN_LIMITS_V1`).** The planner rejects a submission
   before any workflow starts when any of these is exceeded:

   | Limit | Ceiling |
   |---|---|
   | Selected tasks per run | 1,000 |
   | Workflow input | 1 MiB of UTF-8 JSON |
   | `concurrency` | 8 (the SDK's 10 slots minus 2 reserved for orchestration work) |
   | `maxRetries` | 10 |
   | `retryDelayMs` | 24 hours |
   | `historyRolloverUnits` | 1 to 1,000 (default 64) |

2. **History rollover.** The run workflow counts history units: child
   dispatches plus processed control wakes. When the count reaches
   `historyRolloverUnits`, it calls `continueAsNew` at a task boundary, but
   only when no wave is in flight and no control is pending.
   - The continuation carries task statuses, the next logical attempt per
     task, the replay cycle, and the generation number. It does not re-run
     completed work and does not reuse operation IDs.
   - Each new generation drains accepted, unapplied run controls through the
     `listAcceptedRunControls` activity (up to 64), so a wake raised during
     rollover is not lost.
3. **Child workflow per task attempt is kept.** It isolates retry and approval
   history per task and preserves deterministic task-attempt instance IDs and
   evidence. Approval waits are capped at 16 per logical attempt; beyond that,
   the attempt fails closed with `wait-limit-exceeded`.
4. **Bounded outcomes and artifacts.**
   - Task outcomes are capped at 256 KiB before they enter history.
   - Failure diagnostics are truncated (reason to 4,000 characters, gate text
     to 1,000 characters, at most 32 gate evidence entries), with the
     truncation marker counted inside each cap.
   - Oversized completion evidence is never altered; it fails with
     `outcome-too-large`.
   - Artifact publication rejects bytes over 32 MiB (512 MiB for checkpoint
     Git bundles) with `artifact-too-large`.
5. **Backpressure.** `RunAdmissionController` reserves a run's planned
   concurrency before its workflow is scheduled. The total is capped at 8
   active task attempts per worker. A run that does not fit is rejected with
   `worker-capacity-exhausted` for the caller to retry later; it is never
   queued inside the SDK.
6. **SDK workaround.** A controls-enabled run waits on each still-running child
   plus the control event with `whenAny`, in a loop, and reads the wave's
   results from the completed children. It still uses `whenAll` when no control
   event is armed. Any `whenAll` covers only the children that are still
   running; results for children that already finished are read directly.
   Regression tests pin both SDK defects so the workaround can be revisited
   when the SDK is upgraded.

## Evidence

`npm run measure:bounds` (in `tools/dapr-engine/`) runs the measurements against
an ephemeral rootless Podman Dapr 1.18.7 stack. The plan's
[P4-06 bound evidence](../../plan.md#p4-06-bound-evidence) section records the
results: rollover generations, peak history rows and bytes with and without
rollover, retry-storm concurrency, a long wait with zero history growth across
a worker restart, controls across frequent rollover, admission refusal, and the
stored size of an oversized outcome.

## Consequences

- Run history stays bounded by the rollover budget rather than the manifest
  size; each generation still carries the full submission as input, which the
  1 MiB input cap bounds.
- Hosts must create an admission reservation before scheduling and release it
  when the run ends. They must also implement `listAccepted` on their control
  store.
- Defaults are conservative for a single local worker. Multi-worker or hosted
  qualification is deferred to later phases.
- If a future SDK changes the worker slot counts, `DAPR_SDK_WORKER_LIMITS` and
  its pin test must be updated together.
