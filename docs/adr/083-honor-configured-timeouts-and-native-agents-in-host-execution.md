---
id: ADR-083
type: adr
title: Honor configured task timeouts and native agents in host execution
status: accepted
date: '2026-10-24'
---

# ADR-083: Honor configured task timeouts and native agents in host execution

## Context

Host execution runs a locally installed harness against a disposable clone of
the registered repository. Three configuration values were not reaching that
clone:

- **Agent selection.** The manifest agent path points at the registered
  checkout. Native selection compared that path with the clone root, so it never
  matched `.opencode/agents/` and the adapter fell back to the inline persona.
  The OpenCode session showed its default agent even though the task named a
  forge agent.
- **Model selection.** The OpenCode, Claude Code, and Copilot adapters parsed a
  default model from their extra-flags environment variable but only passed
  `request.effectiveModel` to the CLI. A run whose agent descriptor had no model
  therefore used the CLI's global default.
- **Task timeout.** The service constructed the execution host with a
  hard-coded 15-minute supervision budget. A larger per-task timeout could reach
  the harness request but not the ownership deadline, so the supervisor aborted
  first. The Console's task-timeout setting appeared to have no effect.

The first two problems are host-only because the worker path executes in the
registered checkout. The timeout problem affects both executors whenever a task
timeout exceeds the service default.

## Decision

- Rewrite a manifest agent path into the disposable clone before invoking the
  harness when the path is inside the registered repository. Native agent
  selection additionally requires the agent file to exist, so an uncommitted
  agent file degrades to the inline persona instead of passing a missing name.
- Let every adapter use `request.effectiveModel` first and the parsed
  extra-flags default second.
- Size the supervised execution budget to the largest configured timeout:
  `max(service default, task timeout, run timeout)`. Use the run timeout first,
  then the task timeout, then the service default for post-execution validation.
- Keep the service default as the fallback for tasks and runs that do not set a
  timeout. A Console setting applies to a new submission because the manifest
  snapshot is immutable; it does not retroactively change a running run.

## Consequences

- A host-runner session shows the configured forge agent and passes the
  configured model to the CLI.
- A 45-minute task is no longer killed at 15 minutes by the ownership deadline.
- The timeout setting remains per submission. Operators must start a new run
  after changing task timeouts; an existing run keeps its snapshot.
- Agent files must be present in the cloned base revision for native selection.
  Uncommitted agent files continue to work through the inline persona, but the
  session will not show that agent name.

## Alternatives considered

- **Require agent files to be committed before any host run:** stricter, but it
  breaks the existing inline-persona fallback and makes a missing file a hard
  failure.
- **Read the default model only from the environment:** simpler, but per-agent
  model assignments in the manifest would still be ignored.
- **Raise the service default to 45 minutes:** hides the missing per-task
  timeout and makes every short task wait on an unnecessarily long lease.
