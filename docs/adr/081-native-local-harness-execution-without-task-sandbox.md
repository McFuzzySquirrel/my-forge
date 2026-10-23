---
id: ADR-081
type: adr
title: Native local harness execution without task sandbox
status: accepted
derived_from:
  - SDR-20261022-003
date: '2026-10-23'
---

# ADR-081: Native local harness execution without task sandbox

## Context

The default worker-container runner uses harness CLIs and operator-granted
credentials provisioned for the local runtime. The user requires Dapr-backed
service runs to also use harness CLIs installed on the user's machine, with
their normal local authentication, while keeping Dapr as the workflow owner.
This trades task-level OS isolation for direct use of the native CLI
environment, and must be explicit because the host process runs with the
operator's full permissions.

## Decision

- Keep worker-container execution as the default and offer native host
  execution only through explicit run selection.
- Use a launcher-managed host runner to invoke the configured local CLI as the
  logged-in user against a disposable workspace cloned from the registered
  repository at the accepted revision. The workspace is not an OS security
  boundary; the CLI and child tools have the user's normal filesystem,
  process, and network permissions.
- Scope the project capability to Dapr-to-runner authorization only. It is
  distinct from provider credentials, the service API token, and Dapr
  authentication.
- Keep Dapr responsible for orchestration, validation, checkpointing, and
  repository integration. Missing or incompatible host execution must fail
  clearly; never silently fall back to worker-container execution.

## Consequences

- Users can use their locally installed CLI and its normal authentication
  without copying provider credentials into Dapr submissions.
- Host execution does not confine task tools to the workspace. The CLI and its
  child tools can access resources available to the logged-in user, including
  the CLI auth store, runtime credentials, host-runner capabilities, SSH and
  cloud credential files, and browser data. Host execution does not use worker
  harness grants or enforce one-provider isolation.
- Provider authentication, process-tree cleanup, workspace handoff, and
  per-host-OS support require separate qualification. No host OS is qualified
  by this decision alone.
- The operator-facing boundary and incident-response guidance are documented in
  [Harness credentials and execution boundaries](../harness-credentials.md#host-execution-warning).

## Alternatives considered

- **Pinned worker-container CLIs:** retain the worker execution boundary and
  centrally provisioned versions, but do not use the operator's local CLI
  installation and authentication.
- **Sandboxed host CLI:** limits task access, but conflicts with the required
  native execution and local authentication model.
- **Unsandboxed native host CLI:** selected to use the operator's installed
  CLI and authentication, with explicit disclosure of full user permissions.

## References

- [Local host harness execution contract](../features/local-host-harness-execution.md)
- [Local execution architecture](../local-execution.md)
- [ADR-076: Per-task process privilege isolation](076-task-process-privilege-isolation.md)
- [ADR-077: OpenCode provider credential isolation](077-opencode-provider-credential-isolation.md)
- [Host-runner spike report](../research/host-runner-spike.md)
