# AGENTS.md

Guidance for AI coding agents working in this repository (MyForge).

## Repository layout

- `templates/skills/` — the forge skills. Most are small TypeScript/Node packages
  (own `package.json`, `tsconfig.json`, `scripts/`) that get bootstrapped into
  target repos. `forge-workflow-engine` is a retired scheduler reference; bootstrap
  ships only its retirement notice and Dapr-independent execution utilities.
  `forge-execution-adapter` compiles manifests. `templates/agents/` holds forge
  agent personas.
- `scripts/` — the `forge-launcher` npm package (`scripts/forge-launcher/`) plus
  thin bash/PowerShell wrapper scripts that delegate to it.
- `tools/dapr-engine/` — the Dapr replacement source package. Its
  `execution/` library is Dapr-independent and is staged inside the legacy
  workflow-engine skill by launcher bootstrap. `contract/v1/` holds the
  Dapr-independent contract primitives and `tests/conformance/` the contract
  §5 fixtures (not staged by bootstrap). The service runtime is managed by the
  launcher in the local Podman deployment; it is not scaffolded into target
  repositories.
- `docs/` — human documentation: `updates.md` (the versioned changelog),
  `adr/` (architecture decision records), deep-dive guides, `research/`, and
  `documentation-map.md`. Generated artifacts (`EXECUTION-MANIFEST.json`,
  `PROGRESS.md`, …) are written by the skills into target repos and are not
  source-controlled hand-edits here.
- `plan.md`, `README.md` — project overview and usage. The README opens with a
  `**Latest: v3.x**` line that tracks the top section of `docs/updates.md`.

## Conventions

- **Changelog:** every user-visible change adds a new
  `## <Month> <Year> - v<ver>` section at the top of `docs/updates.md` and bumps
  the README's `**Latest:**` line. Notable features also get a new ADR under
  `docs/adr/NNN-*.md` (increment the number; ADR-080 is the latest).
- **Documentation and reference checks:** use
  [`docs/documentation-map.md`](docs/documentation-map.md) to identify the
  authoritative documents and update triggers before changing code. Update
  affected `SKILL.md`, README, guide, deep-dive, ADR, and changelog files in
  the same change as the behavior they describe. Check links, filenames,
  commands, flags, environment variables, examples, and migration guidance.
  If no documentation needs changing, state why in the completion summary.
  Retirement docs must distinguish active commands from preserved historical
  records.
- **Requirements:** the active contract is `docs/PRD.md` plus
  `docs/features/*.md`, as described in [`docs/canonical-features.md`](docs/canonical-features.md).
  Treat generated manifests as execution snapshots, not a second source of
  requirements. Preserve historical ADRs and changelog entries when behavior
  is retired.
- **Commit style:** short `feat:`, `fix:`, `docs:`, `refactor:` prefixes,
  imperative mood, matching the existing history. Only commit/push when asked.
- **Never commit `node_modules/` or `dist/`** — they are gitignored in every
  package and excluded from bootstrap copies; target repos install deps via
  `npm install` at prep time.

## Build & verify

Each skill package and the launcher has its own scripts (run from that package's
directory):

```bash
npm install          # first time; installs deps locally (never committed)
npm run typecheck    # tsc --noEmit
npm test             # node --test suite
```

Package test globs: the retired workflow-engine stub runs
`scripts/**/*.test.ts`; the execution adapter and launcher run
`scripts/*.test.ts`; `tools/dapr-engine` runs `tests/**/*.test.ts`.
Some packages expose entry commands (for example,
`npm run forge-execution-adapter -- compile`); consult the package README for
supported commands.
Install `tools/dapr-engine/` dependencies separately; its typecheck covers the
canonical execution library and contract primitives, its `npm test` runs the
service, execution, and contract tests. The retired workflow-engine package
only verifies its fail-closed compatibility stub.

The dev-only `tools/console-screenshots` package regenerates the Forge Console
screenshots and visual tour (`npm --prefix tools/console-screenshots run capture`;
needs `google-chrome` and `ffmpeg`). See
[`docs/forge-console-screenshots.md`](docs/forge-console-screenshots.md).

The dev-only `tools/runtime-qualification` package runs the P6/P7 live
qualification suites against isolated rootless Podman runtimes
(`npm --prefix tools/runtime-qualification run -s qualify -- failures|backup|upgrade|cutover`; needs
`scripts/forge-launcher` dependencies). See `docs/testing-guide.md` §4a.

## Tools

- CodeGraph indexes this repo (`.codegraph/`). Prefer `codegraph_explore` before
  grepping/reading when locating or understanding code.
<!-- dg:begin -->
Run `dg context <files>` before editing.
Record decisions with `dg sdr add`.
MCP server: `dg mcp`.
Agent skill: `.agents/skills/decision-graph/SKILL.md`.

## Accepted rules
No accepted rules are indexed.
<!-- dg:end -->
