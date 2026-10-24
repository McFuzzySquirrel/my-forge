---
id: SDR-20261023-001
type: sdr
title: Per-run executor selection in the Console
status: promoted
applies_to:
  - scripts/forge-launcher/scripts/console/**
  - docs/forge-console.md
tags: []
date: '2026-10-23'
promoted_to: ADR-082
agent: opencode
---

# SDR-20261023-001: Per-run executor selection in the Console

## Decision

Console-started runs carry an explicit worker or host executor per run. The saved hostExecution value in docs/engine-config.json only preselects the Console selector and changes only through an explicit save action. An explicit host request is preflighted for repository registration, runner capability, and runner readiness before submission. CLI submission commands (engine-run, service submit) remain explicit-only and never read the saved preference.

## Why

Operators choose an executor where they run the build, and a saved GUI preference must not silently elevate a script to unsandboxed host execution. Readiness failures should surface before a submission is created instead of as a late service rejection.

## Alternatives considered

- Persist the executor on change
- Make engine-run and service submit read the saved default
- Keep the project-level checkbox and only improve its label
