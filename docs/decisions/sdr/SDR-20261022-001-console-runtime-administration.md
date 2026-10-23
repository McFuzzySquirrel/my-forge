---
id: SDR-20261022-001
type: sdr
title: Console runtime administration
status: open
applies_to: []
tags: []
date: '2026-10-22'
promoted_to: null
---

# SDR-20261022-001: Console runtime administration

## Decision

Expose runtime lifecycle, registry, backup/restore, token, and harness-credential operations through a dedicated loopback Console page. Persist the last applied repository registry and start options so mount changes are restart-pending and restarts retain host-tools settings.

## Why

Runtime administration was CLI-only, preventing users from registering selected projects or managing the service without leaving Console. Shared runtime helpers retain validation, while explicit confirmations and secret redaction protect destructive and credential actions.

## Alternatives considered

None.
