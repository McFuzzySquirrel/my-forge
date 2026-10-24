# ADR-075: Security Boundary Review Before Cutover

**Status:** Accepted  
**Date:** 2026-10-21

## Context

P6-04 requires a review of the replacement runtime's security boundaries:
unauthorized and stale approvals, cross-repository access, escaping paths and
symlinks, secret exposure in logs, malicious artifact metadata, exhausted
resource limits, and a dependency scan. Relevant findings must be resolved
before cutover.

## Findings

1. **HIGH — validation commands saw worker secrets (fixed).** Manifest
   `validationCommands` ran through `runTaskValidation` with the worker's full
   environment: `MYFORGE_API_TOKEN`, `DAPR_API_TOKEN`, and the PostgreSQL URL
   with its password. A repository could forge approvals, call the Dapr
   sidecar, read the database directly, or copy secrets into evidence that is
   later backed up.
2. **HIGH — the runtime shares registered repositories' `.git` metadata
   (write/grant access fixed; read access accepted within one trust domain).**
   Initially, harness processes ran as container root and could modify every
   registered repository and read every harness grant. ADR-076 removed task
   write access to source `.git` directories and grants. Tasks can still read
   Git metadata and objects from every registered repository.
3. No dependency vulnerabilities. `npm audit` reports 0 in `tools/dapr-engine`,
   `scripts/forge-launcher`, `forge-workflow-engine`,
   `forge-execution-adapter`, and `tools/console-screenshots`.

## Decision

- Validation commands receive the same credential-free isolated environment as
  harness attempts, built by `buildHarnessEnvironment` with no credentials. It
  has a per-attempt `HOME`, does not inherit the worker environment, and its
  process group is reaped. The change applies to `runTaskValidation`
  (`validationEnvironment` on admission) and to the host's resume-path
  validation. Regression: the T-1 validation command in
  `execution-host.integration.test.ts` fails if `POSTGRES_TEST_URL`,
  `DATABASE_URL`, or `GH_TOKEN` is visible, or if `HOME` is `/root`.
- The original write/grant portions of finding 2 are resolved by ADR-076. The
  remaining cross-repository read is accepted only for a local runtime whose
  registered repositories, harnesses, and task/validation work are mutually
  trusted; this scope restriction is a P6-GATE decision, not a technical
  isolation guarantee. The implemented controls are:
  - Run harness and validation processes as a dedicated unprivileged UID.
  - Give that UID a writable workspace and home, but no write access to
    `/repositories/*/.git` and no read access to the grants file.
  - Pass grants only to the selected harness, through its environment.

  Doing this needs worker image and git-ownership changes, followed by live
  re-qualification of each harness; see ADR-076 and the P6 evidence.

## Live evidence (`myforge-qual`, 2026-10-21)

| Probe | Result |
|---|---|
| No token / wrong token | 401 / 401 |
| Valid token + foreign `Origin` | 403 |
| Valid token + foreign `Host` | 421 |
| Valid token | 200 |
| 2 MB request body | 413 |
| API token in forge container logs | 0 occurrences |
| Published ports | API `127.0.0.1:18483` only; daprd 3500/50001 are not published |

Unit coverage already exercises stale and forged approvals, artifact path
traversal, symlink and absolute output escapes, and control size limits.

## Consequences

- Repository-defined commands can no longer read runtime credentials.
- The remaining Git-metadata read is permitted only when each repository and
  harness registered to one local runtime is explicitly trusted. Use separate
  runtime installations for distinct trust domains; this is not multi-tenant
  isolation.

## Implementation update — 2026-10-21

[ADR-076](076-task-process-privilege-isolation.md) implements per-attempt
unprivileged UIDs. Tasks can no longer write registered source `.git` mounts
or read the shared grants file. The mounts remain readable, however.

## Trust-domain acceptance — 2026-10-21

The operator accepted the shared-trust-domain route for P6-GATE. A task may
read Git metadata and objects from every repository registered to the same
local runtime. Registration is limited operationally to repositories,
harnesses, and task/validation work that the operator trusts to share that
access. Use separate runtime installations for repositories outside the
trust domain. This does not protect mutually untrusted repositories from one
another; adding such repositories or claiming multi-tenant isolation reopens
the finding and requires a filesystem/mount boundary.

## Validation-home correction — 2026-10-24

The normal admission path previously built the validation environment from the
harness's own per-attempt home. That home contains the private OpenCode data
directory where `OPENCODE_AUTH_JSON` is imported, so a repository validation
command could read the credential even though it received no credential
environment variables. The admission path now creates a separate empty
validation home, matching the resume path. The integration suite checks that a
marker written into the harness home is invisible to validation commands. See
[ADR-077](077-opencode-provider-credential-isolation.md) and
[Harness credentials and execution boundaries](../harness-credentials.md).
