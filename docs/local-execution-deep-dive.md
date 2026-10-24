# Local Execution: A Code-Grounded Deep Dive

> **Current architecture:** this guide traces the active Dapr-backed
> service-run path from launcher submission through durable orchestration,
> harness execution, result verification, and operator monitoring. It does not
> cover the removed pre-Dapr scheduler.

Start with the [local execution overview](local-execution.md) for component
roles and the compact system diagram. This guide adds implementation detail
without replacing the [versioned application contract](contracts/dapr-execution-v1.md),
the [feature requirements](features/dapr-execution-boundary.md), or the
[launcher command reference](forge-launcher.md).

## Terms and authority

| Term | Meaning in the current implementation |
|---|---|
| Service run | One accepted immutable submission and its durable task workflow. |
| Execution service | The local HTTP API and Dapr Workflow worker in `tools/dapr-engine/service/`. |
| Worker runner | The in-process harness adapter selected for ordinary worker-container execution. |
| Host runner | The separate launcher-managed process that polls durable jobs and executes a local harness when a run explicitly selects host execution. |
| Attempt | One execution of a task under a logical attempt identity and operation ID. |
| Accepted result | A harness result that has passed the task's result, output, no-op, artifact, and validation gates. |
| Completion record | Durable evidence that an integrated task is already present at a revision; later runs replay it and hydrate its work artifact for dependants. |
| Runtime evidence | Content-addressed work, validation, and Git-bundle artifacts plus the completion ledger exposed by the service evidence API. |

The launcher is the submission and operator client. The execution service
validates and binds submissions, but Dapr Workflow owns run/task scheduling.
The activity layer owns side effects and acceptance checks. The worker and host
runner are alternative harness-execution adapters, not alternative
orchestrators.

## 1. Compile and submit an immutable run

`scripts/forge-launcher/scripts/service-run.ts` implements the
`run` path. It:

1. Resolves the repository and requires it to be registered with the local
   runtime.
2. Checks authoring readiness and selects the harness root and harness.
3. Compiles the manifest if it is missing or an explicit granularity override
   requires recompilation.
4. Attaches to, resumes, or submits the active service run for the repository.

The `service submit` path uses `submitRepositoryRun` in
`scripts/forge-launcher/scripts/service-client.ts`. That function reads the
compiled manifest and agent descriptions, prepares a dedicated
`forge/<base>` target branch, builds a snapshot, and calls the client's
`POST /v1/runs` operation. `ServiceClient` adds the service bearer token and
normalizes transport failures for launcher callers.

`buildRunSubmission` freezes the manifest and relevant agent descriptions,
computes the manifest digest, records selected task IDs and non-secret
settings, and assigns a submission key. The service validates the request
again; it does not trust the launcher to enforce contract rules. An identical
transport retry can resolve to the existing run, while reuse of a submission
key with a different snapshot is rejected. The normative identities, snapshot
fields, and bounds are defined in `contracts/dapr-execution-v1.md`.

## 2. Admit and durably schedule the run

`tools/dapr-engine/service/api.ts` handles the HTTP surface. Health checks are
separate from `/v1` operations. A `/v1` request must use a loopback Host value,
must not come from a browser Origin, and must present the service bearer token.
The launcher binds the published service port to loopback; the service's
container listener is not itself a public network endpoint.

For `POST /v1/runs`, the API delegates to `RunService.submit` in
`tools/dapr-engine/service/runs.ts`. The service:

- validates the repository ID, target ref, snapshot shape, configured limits,
  harness availability, and requested task selection;
- resolves the registered repository and rejects a target branch that is
  checked out in the repository worktree;
- validates and freezes the effective task selection;
- binds the accepted submission to an execution adapter and persists it under
  an idempotent submission identity;
- creates the application-owned run-status record and schedules the Dapr
  workflow using a stable workflow instance ID.

The API's authenticated routes expose submission, run status, lifecycle events,
controls, (when enabled) host-runner operations and bounded job summaries, and
read-only completion evidence. The evidence routes list records for a repository
and resolve an artifact only after checking it belongs to one of that
repository's completions. They do not expose Dapr internals as the public
application contract.

At startup, `tools/dapr-engine/service/main.ts` initializes PostgreSQL-backed
stores, loads the capability hashes available to the worker, creates the run
registry and `ExecutionHost`, registers the Dapr workflows and activities, and
binds stored submissions before starting the Workflow runtime. It waits for
PostgreSQL and the Dapr sidecar, executes a workflow-admission probe, recovers
stored runs, and only then marks the API ready.

## 3. Dapr Workflow owns the task lifecycle

`tools/dapr-engine/orchestration/workflow.ts` contains the deterministic run
and task-attempt workflows. A run workflow plans ready tasks from the accepted
manifest snapshot and dispatches task-attempt child workflows. Task attempts
call named activities for task execution and any accepted control/resume
work. Durable timers represent retry delays; external events wake waits for
human approval or run controls. Long histories roll forward with
continue-as-new at defined task boundaries.

Workflow code decides *when* work is eligible and records durable progress. It
does not invoke a harness directly. Activity execution is delegated to the
registered `ExecutionHost` in `tools/dapr-engine/orchestration/execution-host.ts`.
Stable operation IDs and application-owned receipt and execution-ownership
records fence duplicate or stale activity delivery. Repository integration,
checkpoint publication, and status updates remain activity effects rather
than workflow-history payloads.

The launcher may poll or follow the run, and the Console may submit acknowledged
controls, but neither client becomes the scheduler. Service controls are
persisted and raised as Dapr events; a control acknowledgement means the
service accepted the request, not that an in-flight harness has already
stopped.

## 4. `HarnessRunner` is the execution seam

`tools/dapr-engine/execution/runner-contract.ts` defines the typed
`HarnessRunner` request/result interface. A request carries the repository,
accepted base revision, task and agent data, harness selection, timeout, and
stable run/task/attempt identity. A result carries the same identity, a
structured task result, and a versioned workspace delta. The parser rejects
malformed requests, oversized context, and responses that do not match the
requested attempt.

`ExecutionHost` prepares the task workspace and supervises the activity. It
supplies `executeVerifiedTaskActivity` with the host-runner adapter only when
the accepted run binding selected host execution. In that case it does not
resolve worker harness credentials for the host process.
`executeVerifiedTaskActivity` constructs the typed request, invokes the
selected runner, imports the returned workspace delta, and then uses the same
result-admission path as worker execution.

The seam is intentionally narrow:

```text
ExecutionHost
    -> executeVerifiedTaskActivity
        -> HarnessRunner.run(request, signal)
            -> worker adapter OR durable host queue adapter
```

The runner returns a task result; it does not accept or integrate that result
on its own. The activity remains responsible for verifying the effect before
it becomes durable repository state.

## 5. Worker-container execution

For the default mode, `ServiceRunRegistry` binds the accepted submission to
the selected service harness adapter. `ExecutionHost` builds the worker-side
harness environment, including only the credentials granted for that
execution, and `executeVerifiedTaskActivity` invokes the adapter on the
prepared workspace.

The task activity then checks the changed workspace against the task contract:

1. Compare the result with the captured baseline.
2. Validate the structured task handoff and declared outputs.
3. Apply the configured no-op policy.
4. Install missing project dependencies, then run the required validation
   commands in the isolated validation environment.
5. Publish any declared artifacts and one validation record.
6. Capture a checkpoint, record the completion, and integrate the verified
   effect into the run branch.

Worker and host execution use the same validation implementation. The host
runner performs validation in its disposable clone; the worker performs it in
its managed workspace, after installing dependencies that are absent there.
Failures at an admission or integration gate are represented as task outcomes;
an unaccepted task result does not become an integrated repository change.

## 6. Native host-runner dispatch

Host mode is selected in the run's snapshotted settings. Admission also checks
that a compatible harness is available on the host and that the repository
has an enabled project capability. If the selected mode is unavailable, the
service rejects the submission; it does not silently use the worker adapter.

The main path crosses several modules:

1. `ServiceRunRegistry` binds the run to `QueuedHarnessRunner` only for an
   explicitly host-executed run.
2. `executeVerifiedTaskActivity` makes a request with stable run, task,
   manifest, logical-attempt, and operation identity.
3. `QueuedHarnessRunner` validates and enqueues that request in
   `PostgresHostRunnerJobStore`, then waits for a terminal job result. It
   propagates activity cancellation and enforces an execution deadline.
4. The host runner calls `claim` for each repository it is authorized to
   serve. A claim receives a time-bounded lease. The runner polls job status,
   renews the lease, and reports completion or a bounded failure.
5. The service authenticates the project capability, binds operations to the
   lease and repository, checks the returned identity, and stores the result.

The launcher generates a random capability per enabled repository and stores
the values in local runtime data with restrictive permissions where supported.
The service receives only the corresponding capability hashes. The host runner
reads the values and registry, and sends the capability and service bearer
token in request headers. Neither credential is a provider key, nor should
either be placed in the run request or the harness environment.

The host runner is a host-initiated polling client: it does not listen for
inbound service connections. The local service exposes the operator API on a
loopback-published port, and the runner validates that its configured URL is
loopback HTTP.

## 7. Host workspace and result handoff

The worker and host runner do not share a writable task workspace. The typed
request binds the attempt to a repository ID and full accepted Git revision;
it does not contain an arbitrary host path or shell command.

`NativeHarnessRunner` resolves the registered repository path on the host,
creates a private temporary attempt directory, and clones the repository at
the accepted base revision with its remote removed. It invokes the configured
local harness against that disposable workspace. The harness uses its normal
host CLI authentication and runs with the operator's normal OS permissions.
There is no OS or OCI task sandbox; the task workspace is a working directory,
not an access-control mechanism.

After the attempt, `captureWorkspaceDelta` creates a bounded binary Git diff
from the accepted base revision and records a content digest. The runner
removes the temporary workspace and returns the typed result and delta. On the
worker side, `parseHarnessRunnerResult` checks the identity, shape, digest, and
size; `applyWorkspaceDelta` checks the base revision and patch before applying
it to the worker's prepared workspace. The task activity then runs the normal
admission, validation, artifact, checkpoint, and repository-integration path.

This design moves the harness process, not Dapr's workflow state or Git
integration authority. A runner response cannot bypass the worker's acceptance
checks.

## 8. Persistence and recovery

| Data | Owner | Purpose |
|---|---|---|
| Workflow history and durable timers/events | Dapr Workflow | Replayable orchestration decisions and pending waits. |
| Submission snapshots and run/task status | Application PostgreSQL stores | Stable run binding, current status, and queryable lifecycle history. |
| Control records and effect receipts | Application PostgreSQL stores | Idempotent acknowledgements, effect transitions, and redelivery fencing. |
| Host-runner jobs and leases | `PostgresHostRunnerJobStore` | Durable queue, claim lease, cancellation request, and result. |
| Completion ledger | File-backed `completions/` store | Integrated task commit, output files, validation commands, and artifact refs for replay. |
| Artifacts and task checkpoints | File-backed artifact/checkpoint store | Content-addressed work/validation/bundle evidence and verified workspace state. |
| Runner capabilities and repository registry | Launcher runtime data | Host-side authority for registered project polling. |
| Attempt workspaces and harness homes | Worker or host temporary directories | Disposable execution state, cleaned after each attempt. |
| Per-attempt harness activity | Runtime `activity/` files (worker) or host-runner log (host) | Opt-in, bounded and redacted CLI output exposed by the Service runs Activity action. |

The worker rebinds accepted run snapshots when it restarts and recovers
workflows through Dapr. Application-owned receipts and repository fencing
reconcile effects if an activity is redelivered after an uncertain completion.
Host-runner jobs are durable: a lease can expire and a queued or expired job can
be claimed again, while cancellation and identity checks prevent a late or
stale response from being accepted as the current attempt.

These application records complement Dapr history; they do not replace it.
Contract versioning, history limits, retry semantics, and control transitions
are specified in the [Dapr execution contract](contracts/dapr-execution-v1.md).

## 9. Status, controls, and observability

The service API exposes run status, sequenced lifecycle events, and validated
run controls. Launcher commands use `ServiceClient`; the Console uses its
operator session and server-side service proxy. Browser code does not receive
the runtime bearer token or host-runner capability.

The Host runner Console view uses a separate read-only monitoring route. The
PostgreSQL query returns at most 100 active summaries and the 20 most recent
terminal summaries, optionally filtered by repository. It projects only
allowlisted identity, harness, state, and timestamp fields; it does not return
capabilities, job requests or results, CLI output, or raw failure details.

The Console server polls the latest service run and broadcasts a service-backed
snapshot so Overview, Board, and Tasks update on status/task changes. Run
lifecycle events feed **Run events** and **Timeline**; `docs/forge.log` feeds
**Activity log**; the native host-runner log feeds **Runtime log**. The
**Evidence** view reads the completion/evidence API and is independent of
repository-local `docs/artifacts/`. Service task rows expose **Activity** for
opt-in worker harness output; the API reads the bounded per-attempt log. Host
activity remains in **Runtime log**.

Host-mode run summaries identify the executor. Run-level events remain the
source for workflow progress; the runner job view is bounded operational
diagnostics rather than a second run history.

## 10. Source and test map

| Concern | Implementation | Representative tests |
|---|---|---|
| Launcher submit/follow path | `scripts/forge-launcher/scripts/service-run.ts`, `scripts/forge-launcher/scripts/service-client.ts` | `scripts/forge-launcher/scripts/service-run.test.ts`, `scripts/forge-launcher/scripts/service-client.test.ts` |
| Service validation and HTTP API | `tools/dapr-engine/service/runs.ts`, `tools/dapr-engine/service/api.ts`, `tools/dapr-engine/service/evidence.ts` | `tools/dapr-engine/tests/service/api.test.ts`, `tools/dapr-engine/tests/service/runs.test.ts`, `tools/dapr-engine/tests/service/evidence.test.ts` |
| Dapr run/task orchestration | `tools/dapr-engine/orchestration/workflow.ts`, `tools/dapr-engine/orchestration/execution-host.ts` | `tools/dapr-engine/tests/orchestration/workflow.test.ts`, `tools/dapr-engine/tests/orchestration/execution-host.integration.test.ts` |
| Shared runner interface and workspace delta | `tools/dapr-engine/execution/runner-contract.ts`, `tools/dapr-engine/execution/workspace-diff.ts`, `tools/dapr-engine/execution/validation.ts`, `tools/dapr-engine/execution/agent-path.ts` | `tools/dapr-engine/tests/execution/runner-contract.test.ts`, `tools/dapr-engine/tests/execution/workspace-diff.test.ts`, `tools/dapr-engine/tests/execution/validation.test.ts`, `tools/dapr-engine/tests/execution/native-harness-runner.test.ts` |
| Durable host-runner dispatch | `tools/dapr-engine/execution/queued-harness-runner.ts`, `tools/dapr-engine/storage/postgres/host-runner-jobs.ts` | `tools/dapr-engine/tests/service/host-runner.test.ts`, `tools/dapr-engine/tests/storage/postgres-host-runner-jobs.integration.test.ts` |
| Host lifecycle and native invocation | `scripts/forge-launcher/scripts/runtime-host-runner.ts`, `tools/dapr-engine/scripts/host-runner.ts`, `tools/dapr-engine/execution/host-runner-worker.ts`, `tools/dapr-engine/execution/native-harness-runner.ts` | `scripts/forge-launcher/scripts/runtime-host-runner.test.ts`, `tools/dapr-engine/tests/execution/host-runner-worker.test.ts`, `tools/dapr-engine/tests/execution/native-harness-runner.test.ts` |
| Safe job summaries | `tools/dapr-engine/service/host-runner-monitor.ts`, `tools/dapr-engine/storage/postgres/host-runner-jobs.ts`, `scripts/forge-launcher/scripts/console/host-runner-jobs.ts` | `tools/dapr-engine/tests/service/host-runner-monitor.test.ts`, `scripts/forge-launcher/scripts/host-runner-jobs.test.ts` |
| Completion replay | `tools/dapr-engine/execution/task-completions.ts`, `tools/dapr-engine/orchestration/execution-host.ts` | `tools/dapr-engine/tests/execution/task-completions.test.ts`, `tools/dapr-engine/tests/orchestration/execution-host.integration.test.ts` |
| Console evidence and live activity | `tools/dapr-engine/service/evidence.ts`, `scripts/forge-launcher/scripts/console/service-runs.ts`, `scripts/forge-launcher/scripts/console/dashboard/views/evidence.ts`, `scripts/forge-launcher/scripts/console/server.ts` | `tools/dapr-engine/tests/service/evidence.test.ts`, `scripts/forge-launcher/scripts/console-service-runs.test.ts`, `scripts/forge-launcher/scripts/console.test.ts` |
| Runtime deployment | `tools/dapr-engine/deploy/compose.yaml`, `scripts/forge-launcher/scripts/runtime.ts` | `tools/dapr-engine/tests/service/deployment.test.ts`, `scripts/forge-launcher/scripts/runtime.test.ts` |

Tests establish the behavior of their respective adapters and contracts. Unit
or package tests alone do not qualify real provider authentication, cancellation
of a provider's full child-process tree, or every host OS. The Linux rootless
worker profile is qualified for stub, Copilot and OpenCode. Native host
execution is implemented, but HR-04 live-runtime/host-OS qualification and
HR-GATE remain pending; native macOS/Windows and Claude are unqualified. The
host-execution feature and project roadmap remain authoritative for outstanding
qualification; do not infer platform support from this guide.

## Related reading

- [Local execution architecture overview](local-execution.md)
- [Dapr execution feature](features/dapr-execution-boundary.md)
- [Native host-execution feature](features/local-host-harness-execution.md)
- [Dapr execution contract v1](contracts/dapr-execution-v1.md)
- [Forge Launcher command guide](forge-launcher.md)
- [Forge Console user guide](forge-console-user-guide.md)
- [Dapr execution cutover decision](adr/079-dapr-execution-cutover.md)
- [Runtime evidence and live Console activity](adr/087-runtime-evidence-and-live-console.md)
- [Remove the pre-Dapr legacy engine](adr/088-remove-pre-dapr-legacy.md)
