---
id: SDR-20261021-001
type: sdr
title: Make Dapr execution mandatory at cutover
status: open
applies_to: []
tags: []
date: '2026-10-21'
promoted_to: null
---

# SDR-20261021-001: Make Dapr execution mandatory at cutover

## Decision

Route every supported launcher and Console execution path through the local Dapr service; unregistered repositories must fail with registration guidance instead of falling back to the legacy scheduler. Do not import legacy histories, and document service-stop plus matching pre-cutover backups as rollback prerequisites.

## Why

P7 is a sole-engine cutover, and a silent per-repository legacy fallback would keep two schedulers active after the gate. Legacy task histories are not compatible with Dapr workflow history, so refusing fallback and documenting archival/recovery avoids implying unsafe migration or rollback.

## Alternatives considered

None.
