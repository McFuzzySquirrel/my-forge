# Feature: Local Host Harness Execution

**PRD:** [Foundation vision](../PRD.md)
**Roadmap:** [Post-P7 host-runner follow-up](../../plan.md#post-p7-follow-up--native-local-host-runner-execution)
**Tracking:** [Issue #18](https://github.com/McFuzzySquirrel/my-forge/issues/18)
**Decision record:** [ADR-081: Native local harness execution without task sandbox](../adr/081-native-local-harness-execution-without-task-sandbox.md)
**Originating SDR:** [SDR-20261022-003](../decisions/sdr/SDR-20261022-003-native-local-harness-execution-without-task-sandbox.md)

## 1. Feature overview

**ID Prefix:** HOST-RUNNER
**Summary:** Keep Dapr as the durable workflow orchestrator while a
launcher-managed host runner invokes the user's locally installed harness CLI
directly on the machine where the user is working.
**Dependencies:** Dapr local deployment and access profiles.
**Priority:** Should

## Implementation status

HR-01 through HR-03 are implemented: the host runner polls the loopback service
API, reconstructs a disposable workspace from a registered repository and
accepted base revision, and returns a bounded binary Git diff for the existing
Dapr validation/integration path. The launcher and Console manage runner
lifecycle and project capabilities; the Console also exposes bounded,
allowlisted job summaries. Host mode remains explicit and unsandboxed. HR-04
and HR-GATE remain pending live runtime, local CLI/provider-auth,
process-cleanup, and per-host-OS qualification. No host OS is claimed as
qualified by unit tests or package-build checks alone.

## 2. User stories

| ID | As a... | I want to... | So that... | Priority |
|---|---|---|---|---|
| HOST-RUNNER-US-01 | local operator | run Dapr-orchestrated tasks with a compatible harness installed on my host | I can use my existing local CLI setup without baking every harness version into the worker image | Should |
| HOST-RUNNER-US-02 | local operator | scope host-runner authorization to a registered project | one project's execution cannot authorize another project's runner requests | Must |
| HOST-RUNNER-US-03 | local operator | use the harness CLI installed on the machine where I work | Dapr can use my normal local CLI setup and authentication instead of a separately pinned worker CLI | Must |

## 3. Canonical requirements

```forge-requirement
{"id":"HOST-RUNNER-01","kind":"requirement","text":"Keep Dapr as the workflow orchestrator and add a narrow harness-execution interface that can use either the existing worker-container adapter or an opt-in launcher-managed host-runner adapter. The host runner invokes only configured, compatible harness CLIs already installed on the host and returns structured outcomes, status, and cancellation acknowledgement."}
```

```forge-requirement
{"id":"HOST-RUNNER-02","kind":"requirement","text":"Authenticate Dapr-to-host-runner requests with a cryptographically random capability unique to the registered project. Store and rotate/revoke capability material in owner-only local runtime data; expose it only to the trusted execution service and host runner. Never use it as a provider credential or Dapr sidecar/API token, and never include secret values in submissions, events, task environments, logs, or UI responses."}
```

```forge-requirement
{"id":"HOST-RUNNER-03","kind":"requirement","text":"Bind each host-runner request to an authorized project, immutable run/task/attempt identity, typed harness invocation, and managed task workspace. Resolve the working directory from the registered project and accepted run state; reject arbitrary command strings, caller-supplied host paths, unregistered projects, stale/replayed capabilities, and cross-project requests. The working directory is the task's workspace and Git-integration boundary, not an OS access boundary."}
```

```forge-requirement
{"id":"HOST-RUNNER-04","kind":"requirement","text":"Invoke the configured, locally installed harness CLI directly as the logged-in user on the machine running the host runner; do not wrap the task in an OS or OCI sandbox. Require explicit host-mode opt-in and clearly disclose that the harness and its child tools have the user's normal filesystem, process, and network permissions, which are not restricted to the task workspace. Never silently switch to another execution mode."}
```

```forge-requirement
{"id":"HOST-RUNNER-05","kind":"requirement","text":"Preserve Dapr-owned orchestration, durable dispatch/recovery, task timeouts, cancellation, validation, checkpoint publication, and repository integration when harness execution is delegated to the host runner. A lost or stale host-runner response must not integrate an unverified or duplicate result."}
```

```forge-requirement
{"id":"HOST-RUNNER-06","kind":"requirement","text":"Use the selected local CLI's normal authentication for the logged-in user, including its supported local configuration, environment, or OS credential store. Do not copy provider credentials into Dapr submissions or confuse the project capability with provider authentication or Dapr service tokens. Provider-specific terms and usage restrictions remain applicable."}
```

```forge-requirement
{"id":"HOST-RUNNER-07","kind":"requirement","text":"Provide explicit host-runner lifecycle, readiness, project enrollment, capability rotation/revocation, and execution-mode selection through the launcher and Console. Host runner listeners must not be reachable from non-loopback network clients, and unsupported host execution must never trigger an unannounced mode change."}
```

```forge-requirement
{"id":"HOST-RUNNER-08","kind":"requirement","text":"Provide an authenticated, read-only operator view of active host-runner jobs and a bounded recent terminal history with optional repository filtering. Expose only allowlisted lifecycle metadata; never return capabilities, raw requests, results, CLI output, or arbitrary failure details."}
```

```forge-requirement
{"id":"HOST-RUNNER-C-01","kind":"constraint","text":"A project capability authorizes only MyForge Dapr-to-host-runner requests. It is distinct from provider credentials, MYFORGE_API_TOKEN, DAPR_API_TOKEN, and Git repository credentials."}
```

```forge-requirement
{"id":"HOST-RUNNER-C-02","kind":"constraint","text":"Host-runner execution is intentionally unsandboxed and runs with the logged-in user's normal OS permissions. The host-runner capability authorizes Dapr requests only; it does not constrain what the harness or child tools can access. Host mode requires explicit user opt-in and a clear full-permissions warning; it never silently falls back to another mode."}
```

```forge-requirement
{"id":"HOST-RUNNER-C-03","kind":"constraint","text":"Run the harness CLI on the same host OS and user account where it is installed. Qualify process launch, paths, authentication, cancellation, workspace handoff, and runtime transport separately for each supported host OS; do not claim an OS is supported before qualification."}
```

## 4. Execution and security design

- Dapr continues to own workflow state and task scheduling. A new `HarnessRunner`
  interface hides in-worker process execution versus authenticated host-runner
  transport from the orchestration caller.
- The host runner is an operator-managed launcher process. Its per-project
  capability is stored locally with restrictive permissions and is never sent
  to a harness subprocess.
- Host mode runs the configured local CLI and its child tools directly under
  the logged-in user's OS account. They have the user's normal filesystem,
  process, and network access; the project capability and task workspace do
  not provide OS isolation. Enabling host mode requires an explicit choice and
  a prominent full-permissions warning.
- The selected transport is host-initiated polling of the loopback service API.
  The host runner resolves only a registered repository ID, clones the accepted
  base revision into a private temporary workspace, and returns a bounded,
  integrity-checked binary Git diff. Never accept arbitrary host paths or
  command strings from Dapr.
- Keep Dapr/runtime service credentials and the runner capability out of the
  harness environment while preserving the local CLI's normal provider
  authentication.
- Qualify native launch and transport on each supported host OS. On a missing
  or incompatible CLI, report the error and require an explicit mode change;
  never silently use the worker-container CLI.
- Host-local execution does not override provider terms. For example,
  DeepSeek's published Terms of Use contain account-transfer restrictions;
  provider-specific usage must be reviewed separately.
- Earlier sandbox probes and the revised user trust boundary are recorded in
  the [host-runner spike report](../research/host-runner-spike.md).

## 5. Implementation tasks

### Phase 1: Prove the native runner seam and workspace handoff

```forge-task
{"id":"HR-01","title":"Prove the native runner seam and workspace handoff","description":"Define a minimal HarnessRunner request/result interface and in-memory test adapter. Compare host-side workspace reconstruction, bounded result transfer, and shared scratch against the current worker-local workspace lifecycle; evaluate the local transport and native CLI invocation on supported host OSes. Record unresolved architecture and platform requirements before production integration.","ownerAgent":"forge-runtime-engineer","dependencies":[],"expectedOutputs":["tools/dapr-engine/execution/runner-contract.ts","tools/dapr-engine/tests/execution/runner-contract.test.ts","docs/research/host-runner-spike.md"],"validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine"],"contract":{"version":2,"kind":"implementation","requirements":[],"requirementRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-01","docs/features/local-host-harness-execution.md#HOST-RUNNER-03","docs/features/local-host-harness-execution.md#HOST-RUNNER-04"],"acceptanceCriteria":["The in-memory adapter proves the typed request/result and cancellation behavior without launching a host CLI.","Workspace transport preserves the accepted base revision and returns only task-produced changes for existing Dapr validation.","The selected transport and supported host OS requirements are recorded before production integration."],"constraints":[],"constraintRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-C-02","docs/features/local-host-harness-execution.md#HOST-RUNNER-C-03"],"references":["plan.md","docs/adr/071-service-harnesses-and-execution-entry-points.md","docs/adr/076-task-process-privilege-isolation.md","docs/adr/077-opencode-provider-credential-isolation.md"]}}
```

### Phase 2: Add the host runner and project capability

```forge-task
{"id":"HR-02","title":"Add the launcher-managed native host runner","description":"Implement a launcher-managed host-runner process that invokes the user's locally installed harness CLI under the logged-in user's account and normal CLI authentication. Add per-project capability generation, owner-only persistence, validation, rotation/revocation, local transport, status, explicit host-mode opt-in, and a full-permissions warning. Reject unauthorized projects, stale attempts, invalid CLI versions, and missing local CLIs without silently changing execution mode.","ownerAgent":"forge-runtime-engineer","dependencies":["HR-01"],"expectedOutputs":["tools/dapr-engine/scripts/host-runner.ts","tools/dapr-engine/service/host-runner.ts","tools/dapr-engine/execution/host-runner-client.ts","tools/dapr-engine/execution/host-runner-worker.ts","scripts/forge-launcher/scripts/runtime-host-runner.ts","scripts/forge-launcher/scripts/runtime.ts"],"validationCommands":["npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher"],"contract":{"version":2,"kind":"implementation","requirements":[],"requirementRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-01","docs/features/local-host-harness-execution.md#HOST-RUNNER-02","docs/features/local-host-harness-execution.md#HOST-RUNNER-04","docs/features/local-host-harness-execution.md#HOST-RUNNER-07"],"acceptanceCriteria":["Capability values are never returned by list/status APIs or emitted in logs and are readable only by trusted runtime components.","A project capability authorizes requests for only its registered project and is revocable without accepting stale requests.","The host runner launches only the configured local CLI as the logged-in user and discloses that it is not sandboxed.","The launcher reports compatible local harness versions and requires explicit host-mode selection and acknowledgement of full user permissions."],"constraints":[],"constraintRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-C-01","docs/features/local-host-harness-execution.md#HOST-RUNNER-C-02"],"references":["plan.md","docs/adr/068-local-deployment-and-access-profiles.md","docs/adr/070-local-operator-session-and-sidecar-token.md"]}}
```

### Phase 3: Integrate Dapr dispatch and workspace results

```forge-task
{"id":"HR-03","title":"Integrate host execution with Dapr activities","description":"Implement durable host-runner dispatch from the Dapr execution host, the selected workspace transport, attempt fencing, timeouts, cancellation, restart recovery, validation, and result import into the existing checkpoint and Git integration flow. Never let a host result bypass existing acceptance and integration checks.","ownerAgent":"forge-runtime-engineer","dependencies":["HR-02"],"expectedOutputs":["tools/dapr-engine/execution/queued-harness-runner.ts","tools/dapr-engine/orchestration/execution-host.ts","tools/dapr-engine/service/runs.ts","tools/dapr-engine/storage/postgres/host-runner-jobs.ts","tools/dapr-engine/tests/execution/host-runner-worker.test.ts","tools/dapr-engine/tests/service/host-runner.test.ts"],"validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine","npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher"],"contract":{"version":2,"kind":"implementation","requirements":[],"requirementRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-03","docs/features/local-host-harness-execution.md#HOST-RUNNER-05"],"acceptanceCriteria":["Dapr remains the sole workflow orchestrator and the execution result is bound to the accepted run, task, attempt, and base revision.","Duplicate, stale, or unauthorized runner responses cannot publish or integrate effects.","Cancellation and timeout terminate the host harness process tree and return a durable outcome.","Imported workspace changes undergo the same validation, checkpoint, and Git integration checks as existing execution results."],"constraints":[],"constraintRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-C-01","docs/features/local-host-harness-execution.md#HOST-RUNNER-C-02"],"references":["plan.md","docs/contracts/dapr-execution-v1.md","docs/adr/069-service-run-submission-and-repository-binding.md"]}}
```

### Phase 4: Qualify and document host execution

```forge-task
{"id":"HR-04","title":"Qualify and document native host execution","description":"Qualify project capability scope, workspace transport, cancellation, capability rotation/revocation, local CLI compatibility, credential redaction, explicit opt-in, and the full-user-permissions warning. Add launcher/Console guidance, provider-terms caveats, changelog entry, and host-OS qualification evidence. Do not claim host support on an OS without its own evidence.","ownerAgent":"forge-runtime-engineer","dependencies":["HR-03"],"expectedOutputs":["scripts/forge-launcher/scripts/runtime-host-runner.test.ts","tools/dapr-engine/tests/execution/native-harness-runner.test.ts","docs/forge-launcher.md","docs/forge-console.md","docs/forge-console-user-guide.md","docs/updates.md"],"validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine","npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher","npm run build --prefix scripts/forge-launcher"],"contract":{"version":2,"kind":"implementation","requirements":[],"requirementRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-02","docs/features/local-host-harness-execution.md#HOST-RUNNER-04","docs/features/local-host-harness-execution.md#HOST-RUNNER-06","docs/features/local-host-harness-execution.md#HOST-RUNNER-07"],"acceptanceCriteria":["A host-runner capability cannot cross project scopes or be used after revocation.","The host CLI runs with the logged-in user's full OS permissions and the UI/CLI discloses this before opt-in.","No provider credential or runner capability appears in logs, lifecycle events, run snapshots, or Console responses.","Missing or incompatible local CLIs fail clearly without silent mode fallback.","Current user documentation accurately distinguishes host auth, provider credentials, Dapr tokens, project capabilities, and the unsandboxed execution model."],"constraints":[],"constraintRefs":["docs/features/local-host-harness-execution.md#HOST-RUNNER-C-01","docs/features/local-host-harness-execution.md#HOST-RUNNER-C-02","docs/features/local-host-harness-execution.md#HOST-RUNNER-C-03"],"references":["plan.md","docs/documentation-map.md","docs/testing-guide.md","docs/decisions/sdr/SDR-20261022-003-native-local-harness-execution-without-task-sandbox.md"]}}
```

## 6. Testing strategy

| Level | Scope | Approach |
|---|---|---|
| Unit | Request validation, capability storage, mode selection, result fencing | In-memory runner adapter and temporary-file fixtures |
| Integration | Dapr dispatch, runner leases, workspace transfer, cancellation | Local service plus test runner, with deterministic response and crash injection |
| Security | Request authorization, secret handling, and explicit trust boundary | Test invalid/revoked/cross-project keys, secret redaction, explicit opt-in, and warning; do not assert OS filesystem isolation |
| Platform | Native host CLI launch and cancellation | Qualify each supported host OS and local CLI profile before support claims |

Key scenarios:

1. Invalid, revoked, expired, replayed, and cross-project capabilities are
   rejected without exposing key material.
2. Host mode is visibly unsandboxed and runs as the logged-in user; the user
   explicitly opts in after seeing that tasks may access files and services
   beyond the registered project.
3. A changed or stale workspace result cannot bypass Dapr validation or
   integrate twice.
4. Timeout, cancel, runner disconnect, and runtime restart leave a durable
   status and do not integrate unverified output.
5. A missing or incompatible local CLI fails with an actionable error; MyForge
   never silently falls back to the worker-container CLI.
6. Provider-specific auth stays in the selected local CLI profile and remains
   subject to provider terms.
7. Operator job history is bounded and repository-filterable; it includes no
   runner capability, request/result payload, CLI output, or raw failure text.

## 7. Acceptance criteria

1. A Dapr-backed task can run a compatible host-installed harness directly
   under the logged-in user's account using the selected local CLI's normal
   authentication.
2. Dapr remains the sole workflow orchestrator; existing result validation,
   checkpoint, retry, and Git integration invariants are preserved.
3. Project capabilities are locally persisted, narrowly scoped, revocable, and
   never confused with provider credentials or Dapr service tokens.
4. Host mode requires explicit opt-in and accurately discloses full logged-in
   user permissions; no sandbox or workspace-only isolation is claimed.
5. Each host OS is qualified before host execution is advertised there; missing
   or incompatible local CLIs fail closed without changing execution mode.

## 8. Open questions

| # | Question | Default assumption |
|---|---|---|
| 1 | Which transport and workspace handoff preserve Dapr's base revision and result checks? | Resolved by HR-01: reconstruct from the registered repository and accepted base revision, then transfer a bounded binary Git diff. |
| 2 | How does the host runner communicate with a Dapr service inside the local container runtime? | Resolved in implementation: host-initiated polling over the service's loopback API; live runtime qualification remains pending. |
| 3 | Which host OSes and local CLI authentication mechanisms are supported? | Unresolved until HR-04 qualifies native launch, cancellation, paths, and the CLI's normal authentication separately on each OS. |
