---
id: SDR-20261022-003
type: sdr
title: Native local harness execution without task sandbox
status: promoted
applies_to:
  - docs/features/local-host-harness-execution.md
  - tools/dapr-engine/**
  - scripts/forge-launcher/**
  - plan.md
tags: []
date: '2026-10-22'
promoted_to: ADR-081
---

# SDR-20261022-003: Native local harness execution without task sandbox

## Decision

Keep Dapr as workflow orchestrator and require a launcher-managed native host runner to invoke the user's installed harness CLI directly on the same machine as the project, under the logged-in user's account, without an OS or OCI task sandbox. Treat local CLI installation as a prerequisite. Keep the project capability limited to Dapr-to-runner authorization, distinct from provider credentials and runtime tokens. Make the full host-user permission model explicit and require the operator to opt in to host execution.

## Why

The user clarified that MyForge should use the harness CLIs installed on the user's machine, not execute them in a sandbox or pinned worker image, so Dapr can continue work through the user's local setup and authentication.

## Alternatives considered

- Per-attempt rootless Podman sandbox with host CLI binaries mounted read-only
- Pinned harness CLIs in the worker container
- Native host process with Landlock filesystem restrictions
