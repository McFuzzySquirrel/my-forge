---
name: decision-graph
description: Use in a repository managed by the decision-graph CLI (`dg`) when triaging parse or lint failures, migrating legacy ADRs, capturing session decisions, or loading scoped decision rules before editing code.
---

# Decision Graph

<!-- dg-skill-version: 1 -->

Use the installed `dg` CLI. Never edit `.dg/graph.db` or `.dg/config.json` by hand.

## Before editing code

1. Run `dg context <files>` to load accepted rules that apply to the paths you will touch.
2. Follow those rules; they come from versioned Markdown records, not from this skill.

## After a significant decision

Capture it with `dg sdr add "<title>" --decision "<what>" --why "<why>"`.
Promote it with `dg sdr promote <id>` when it becomes an ADR. Let `dg adr create` allocate IDs; do not invent them.

## Triage parse and lint failures

1. Run `dg lint --json` and read `diagnostics`.
2. A `schema` diagnostic means the file could not be parsed. Run `dg import <path>` to see the exact error for one file.
3. Fix the source Markdown. Prefer adding explicit frontmatter (`id`, `type`, `title`, `status`, `date`) over renaming files.
4. Run `dg sync`, then `dg lint --json` again.

## Migrating legacy ADRs

- Accepted without frontmatter: `# ADR-0001: Title`, `# ADR 001: Title`, and numbered filenames such as `0001-title.md`, `ADR-0001-title.md`, or `ADR_001-title.md`.
- Inline `**Status:**`, `**Date:**`, and `**Tags:**` lines before the first `##` heading are read when frontmatter is absent.
- `dg import <path> --convert` writes a proposed hybrid draft and keeps the original. Review the draft before accepting it.
- Preserve source digits: `ADR-001` stays `ADR-001`. Do not renumber existing records.
- See `references/legacy-adr-formats.md` for supported shapes.

## Guardrails

- Do not delete or rewrite source ADRs unless the user asks.
- Do not guess a missing ID or title; report the exact `dg` error with the file path instead.
- Re-run `dg sync` after editing record files so the index and graph stay current.
