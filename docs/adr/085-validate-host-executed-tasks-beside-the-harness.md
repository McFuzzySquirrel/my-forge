---
id: ADR-085
type: adr
title: Validate host-executed tasks beside the harness
status: accepted
date: '2026-10-24'
---

# ADR-085: Validate host-executed tasks beside the harness

## Context

Host execution runs the harness in a disposable clone on the operator's
machine, then transfers a Git delta to the service. The service applies that
delta to a second, clean clone and runs the manifest's validation commands as
the task UID.

The two clones have different toolchains. The harness clone contains everything
the harness installed: `node_modules`, browser binaries, and the operator's
caches. The service clone contains only tracked files. A task that scaffolds a
new Node project submits `package.json` and `package-lock.json` but no
`node_modules`; `npm run typecheck`, `npm test`, and `npm run test:e2e` therefore
fail in the service workspace even though the harness ran them successfully on
the host. Installing dependencies and Playwright browsers inside the service
container would add network access, system packages, and a large cache to the
worker image, and would still not reproduce the operator's browser setup.

## Decision

For host execution, run the manifest's validation commands in the disposable
host clone, after the harness and before the workspace delta is captured:

- use the harness environment, including the operator's `HOME`, `PATH`, and
  browser caches;
- install Node dependencies with `npm ci` when the clone has `package.json`
  and `package-lock.json` but no `node_modules`;
- bound stdout/stderr and redact credential-shaped values before returning
  them;
- return the command results with the workspace delta as optional
  `validation` evidence;
- have the service admit that evidence and publish it with the checkpoint
  instead of re-running the commands in its clean workspace.

Worker execution keeps the existing service-side validation and task-UID
isolation. The host runner is already the trusted full-account boundary; this
change does not widen it.

## Consequences

- Host tasks that install dependencies or run browser tests can be verified
  where their toolchain actually exists.
- Validation output crosses the host-runner transport, so it is schema-checked,
  size-bounded, and secret-redacted on the host.
- The service still checks expected outputs, the structured handoff, unresolved
  requirements, and the checkpoint tree. Host validation replaces only the
  command execution, not the other admission gates.
- A rebase onto a moved target still uses the service-side validation path; a
  future change can run that validation on the host as well.

## Alternatives considered

- **Run `npm ci` and install browsers in the service workspace:** adds network
  access, system packages, and a large cache to the service container, and still
  cannot match the operator's browser setup.
- **Transfer `node_modules` in the workspace delta:** the delta is a Git diff
  and deliberately excludes ignored files; a dependency tree would be large,
  platform-specific, and hard to verify.
- **Require the repository to contain installed dependencies at the base
  revision:** impossible for a task whose purpose is to create the project's
  first dependency manifest.
