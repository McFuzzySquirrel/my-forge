# Legacy ADR formats

<!-- dg-skill-version: 1 -->

The decision-graph parser accepts four shapes. Detect the shape with `dg import <path>` or by reading the file.

## Hybrid MADR (native)

YAML frontmatter with `id`, `type`, `title`, and `status`, followed by Markdown sections such as `## Agent Rules`, `## Verify`, and `## Decision Outcome`.

## MADR

A `# Title` heading plus sections such as `## Status`, `## Context and Problem Statement`, and `## Decision Outcome`. IDs come from numbered filenames or an `ADR-0001` heading.

## Nygard / adr-tools

A `# Title` heading plus `## Status`, `## Context`, `## Decision`, and `## Consequences`. Files are usually named `0001-title.md`.

## Agent-optimized

Frontmatter with `rules` or `verify` fields, optionally with an `## Agent Rules` section.

## Inline metadata

When frontmatter is absent, these lines before the first `##` heading are read:

```markdown
# ADR 001: Village Hub

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** architecture, ux
```

## Unsupported shapes

If `dg` reports that it cannot determine an id, add frontmatter rather than renaming the file:

```markdown
---
id: ADR-001
type: adr
title: Village Hub
status: accepted
date: 2026-06-16
---
```
