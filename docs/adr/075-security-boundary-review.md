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
2. **HIGH — one root container holds every repository's `.git` read-write
   (open, blocks cutover).** `runtime-repositories.ts` mounts each registered
   repository's `.git` into the single forge container, and harness processes
   run there as container root, which maps to the operator UID. An untrusted
   harness or validation command can plant hooks or `core.fsmonitor` in any
   registered repository, which leads to code execution on the host. It can
   also read every harness grant in `/run/myforge/harness-grants/grants.json`.
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
- Finding 2 stays open and is recorded as a **P6-GATE / cutover blocker**. The
  required resolution has three parts:
  - Run harness and validation processes as a dedicated unprivileged UID.
  - Give that UID a writable workspace and home, but no write access to
    `/repositories/*/.git` and no read access to the grants file.
  - Pass grants only to the selected harness, through its environment.

  Doing this needs worker image and git-ownership changes, followed by live
  re-qualification of each harness, so it is not combined with this review.

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
- Finding 2 must be resolved, or each registered repository and harness
  explicitly trusted, before cutover.
