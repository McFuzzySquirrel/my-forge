---
id: SDR-20261022-002
type: sdr
title: Sandboxed host harness runner
status: discarded
applies_to: []
tags: []
date: '2026-10-22'
promoted_to: null
---

# SDR-20261022-002: Sandboxed host harness runner

## Decision

Keep Dapr as orchestrator and add an opt-in, launcher-managed host runner behind a typed HarnessRunner seam; authorize Dapr-to-runner calls with a per-project MyForge capability; require OS sandboxing and fail closed when unavailable, with explicit container execution as the alternative.

## Why

Host-installed harnesses can use local CLI setup, but their current task workspaces are inside the worker container and automatic tool execution must not run with unrestricted host access. A separate capability must not be conflated with provider credentials or Dapr tokens, and sandbox plus workspace handoff must be proven before production integration.

## Alternatives considered

None.

## Discard Reason

Superseded by the user's clarification in SDR-20261022-003: native host execution of the user's installed CLI without an OS or OCI sandbox is required.
