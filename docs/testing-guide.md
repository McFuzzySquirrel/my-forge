# Testing guide

This guide captures the current testing workflow for MyForge. It is intentionally focused on the commands and entry points that exist in the repository today.

## 1. Fastest validation path

For day-to-day verification, run the launcher package tests and type checks from the package directory:

```bash
cd scripts/forge-launcher
npm install
npm test
npm run typecheck
```

These commands cover the current launcher implementation, including bootstrap, draft flow, resume flow, engine-run forwarding, and the console path.

### Isolated Dapr foundation experiment

`tools/dapr-spike` is a development-only P1 experiment, not a replacement engine.
It exercises stub activities, durable timers, and an external approval event;
it does not execute manifests, invoke harnesses, or modify target repositories.
The [implementation tracker](../plan.md) records evidence and open acceptance
gates; the [canonical foundation contracts](features/dapr-foundation.md) keep
operator approval separate from automated checks.

From the repository root, install and check the isolated package:

```bash
npm ci --prefix tools/dapr-spike
npm run typecheck --prefix tools/dapr-spike
npm test --prefix tools/dapr-spike
```

Unit/type checks alone do not prove Workflow recovery. Live checks require the
package's explicit rootless Linux Podman setup and persistent volumes; missing
prerequisites must fail rather than silently skip. After installing dependencies,
run the live qualification command from the repository root:

```bash
npm run test:stack --prefix tools/dapr-spike
```

It builds/pulls the pinned images, starts the isolated stack, exercises worker
and full-stack restarts, and refreshes the tracked
`tools/dapr-spike/evidence.json`. A successful run preserves the database,
Scheduler, and artifact volumes. Stop the stack without deleting those volumes:

```bash
npm run spike --prefix tools/dapr-spike -- stop
```

Do not run `clean --confirm-delete-volumes` unless deleting the persistent spike
state is explicitly intended. See `plan.md` for the exact live observations and
limitations. A stub restart test is not proof of Git fencing, provider
idempotency, backup/restore, cancellation, or hosted failover.

### Dapr execution contract conformance

`tools/dapr-engine` runs the [contract v1](contracts/dapr-execution-v1.md)
§5 conformance fixtures against an in-memory reference model:

```bash
npm ci --prefix tools/dapr-engine
npm run typecheck --prefix tools/dapr-engine
npm test --prefix tools/dapr-engine
```

`matrix.test.ts` fails when a §5 case lacks a fixture in its named file. These
fixtures check specified semantics only; they are not durability, Dapr, or
process-cleanup evidence until P3 adapters pass the same cases.

The standard Dapr-engine suite also exercises file-backed artifact and task
checkpoint publication in a temporary directory, including concurrent
content-addressed writes and missing/corrupt-object rejection. Deployment-volume
restart, backup/restore, and retention qualification remain separate work.

P3's PostgreSQL operation-receipt and repository-fencing adapters have opt-in
live integration tests. They passed locally on PostgreSQL 18.6 on 2026-10-13.
The tests exercise durable token allocation, expiry and stale-owner rejection,
serialized integration, ambiguous Git outcomes, atomic Git expected-head
updates, checkpoint-bound integration, and P3-05 Git-effect reconciliation
(already-integrated redelivery, abandoned attempts, and blocked checkpoints), and
P3-06 execution ownership (concurrent starts, heartbeat-expiry takeover with the
original deadline, stale-epoch rejection, cancel-before-publish, and fencing of
lost cancelled executions), and the composed P3-GATE scenarios in
`tests/storage/p3-gate.integration.test.ts`:

- Checkpoint capture and reconstruction after worker loss.
- One accepted effect after an ambiguous integration is redelivered.
- Stale-owner fencing.
- An unresolved integration blocking a dependent task until reconciliation.

The test image is pinned to the Docker Hub multi-platform index digest
`sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c`;
this does not change the PostgreSQL 17.6 image in the historical P1 spike.

To repeat, start a disposable container with a random password, bind only to
loopback, and use no persistent volume:

```bash
set -euo pipefail
PG_CONTAINER="myforge-p3-postgres-$$"
PG_PASSWORD="$(openssl rand -hex 24)"
trap 'podman stop "$PG_CONTAINER" >/dev/null' EXIT
podman run --detach --rm --name "$PG_CONTAINER" \
  --env "POSTGRES_PASSWORD=$PG_PASSWORD" \
  --env POSTGRES_DB=receipts \
  --publish 127.0.0.1::5432 \
  docker.io/library/postgres@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
PG_PORT="$(podman port "$PG_CONTAINER" 5432/tcp | awk -F: '{print $NF}')"
for _ in $(seq 1 60); do
  podman exec "$PG_CONTAINER" pg_isready -U postgres -d receipts >/dev/null && break
  sleep 1
done
podman exec "$PG_CONTAINER" pg_isready -U postgres -d receipts
POSTGRES_TEST_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/receipts" \
  npm run test:postgres --prefix tools/dapr-engine
```

The tests create and drop unique temporary schemas. The temporary container
has no mounted volume, and the shell trap stops and removes it even if the test
fails. The regular unit suite skips the opt-in PostgreSQL tests when
`POSTGRES_TEST_URL` is unset. This qualifies receipt/fencing/execution-ownership persistence and the
local Git integration boundary against PostgreSQL; it does not qualify the Dapr
PostgreSQL state component or the
remaining P3 gate.

## 2. What the automated suite covers

The current package-level test suite exercises the main launcher behaviors:

- bootstrap behavior and path rewriting,
- launcher flow generation and dry-run behavior,
- engine-run argument handling and persistence,
- resume flow behavior,
- console entry-point behavior.

The workflow-engine package uses an explicit recursive Node-based test
discovery entry point. It includes root and nested `.test.ts` files and fails
when no tests are discovered, rather than relying on shell-specific glob
expansion. Each test file has a default 120-second timeout, so a stuck worker
fails before the GitHub job's 15-minute deadline. From the engine package
directory, use `npm test -- --test-timeout=300000` to override this for debugging.
OpenCode lifecycle tests also have 15-second individual deadlines and verify
the actual server PID is gone, not just its Windows command wrapper.

The completed Linux Node 22.22.2 baseline is engine 138/138 (including the
latest process-cleanup and replay-cancellation regressions), launcher 110/110,
and execution adapter 22/22 after `npm ci`; earlier 130/130 and targeted
baselines remain historical. A repository workflow now configures a Node 22
matrix for Linux and
Windows across the launcher, execution adapter, workflow engine, and skill
review packages. It also runs the team validation gate plus launcher build and
version checks. In run
[34192337962](https://github.com/McFuzzySquirrel/mcfuzzy-agent-forge/actions/runs/34192337962),
all seven other matrix jobs passed, but the Windows engine job stopped reporting
after test 133 and reached its 15-minute deadline. Linux completed 199 tests
(198 passed, one skipped). The v3.66 shutdown fix addresses the Windows owned
server cleanup wait; that historical run is not evidence of the fix passing CI.

To run the same package checks locally from the repository root:

```bash
npm ci --prefix templates/skills/forge-execution-adapter
npm ci --prefix scripts/forge-launcher
npm ci --prefix templates/skills/forge-workflow-engine
npm ci --prefix templates/skills/skill-review

npm run typecheck --prefix scripts/forge-launcher
npm test --prefix scripts/forge-launcher
npm run typecheck --prefix templates/skills/forge-execution-adapter
npm test --prefix templates/skills/forge-execution-adapter
npm run typecheck --prefix templates/skills/forge-workflow-engine
npm test --prefix templates/skills/forge-workflow-engine
npm run typecheck --prefix templates/skills/skill-review
npm test --prefix templates/skills/skill-review
node --test templates/skills/forge-build-agent-team/scripts/validate-team.test.mjs
npm run build --prefix scripts/forge-launcher
npm run check:version --prefix scripts/forge-launcher
```

The package also has a dedicated smoke-test script for terminal-launch support under [scripts/smoke-test-launcher-terminal-support.sh](../scripts/smoke-test-launcher-terminal-support.sh).

## 3. Manual smoke test for a full local run

Use this flow when you want to verify the whole experience end to end.

### Prerequisites

- Node.js 18+
- Git
- A compatible harness such as GitHub Copilot, Claude Code, or opencode

### Step 1: Install the launcher from source

```bash
git clone https://github.com/McFuzzySquirrel/mcfuzzy-agent-forge.git
cd mcfuzzy-agent-forge/scripts/forge-launcher
npm install                               # install package deps from the fresh clone
npm pack
npm install -g ./forge-launcher-1.0.0-beta.6.tgz
```

### Step 2: Create a fresh project

```bash
mkdir -p /tmp/myforge-smoke
cd /tmp/myforge-smoke
forge-launcher --non-interactive
```

Use environment variables if you want to drive the setup without interactive input:

```bash
export FORGE_HARNESS_CHOICE="2"
export FORGE_REPO_NAME="my-smoke-app"
export FORGE_REPO_PARENT_DIR="/tmp/myforge-smoke"
export FORGE_IDEA="A simple todo app"
export FORGE_YN_DEFAULT="y"
forge-launcher --non-interactive
```

This bootstraps the repository and then stops with the command to author the PRD.
Requirements are always interactive (ADR-060), so a non-interactive run never
drafts one. Continue the flow by authoring the PRD in a harness session, then
running `forge-launcher resume` — the team, project-skill, manifest, and build
stages then run unattended.

### Step 3: Verify the bootstrapped repository

Confirm that the new project contains the expected structure:

```bash
ls my-smoke-app
```

You should see the harness bootstrap files, docs directory, and initial project files.

### Step 4: Try the console locally

From the generated repo or from anywhere with the installed launcher:

```bash
forge-launcher console --repo /tmp/myforge-smoke/my-smoke-app --no-open
```

This checks that the console can start and serve the local web UI.

## 4. Engine-run smoke test

For a lightweight engine check, run the launcher in dry-run or stub mode where possible:

```bash
forge-launcher engine-run --repo /tmp/myforge-smoke/my-smoke-app --harness stub --yes --dry-run
```

This verifies that the engine-run path resolves the repo, selects the workflow engine package, and builds the command correctly without launching the full workflow.

## 5. Helpful checks when debugging

If a flow fails, confirm the following before digging deeper:

- the repo contains the expected harness folder such as `.agents/`, `.github/`, `.claude/`, or `.opencode/`,
- the launcher package is installed or built locally,
- the workflow-engine and execution-adapter packages exist under the chosen harness root,
- the repo has the expected docs files such as `docs/IDEA.md`, `docs/PRD.md`, or `docs/engine-run.log` depending on the stage reached.

## 6. Recommended validation checklist

Before shipping a change, verify:

- [ ] launcher tests pass,
- [ ] type checks pass,
- [ ] a fresh non-interactive bootstrap works,
- [ ] the console launches locally,
- [ ] any changed docs still match the actual CLI behavior.

> [!WARNING]
> The committed Console screenshots and older walkthrough imagery are historical
> and may predate current controls. Do not use them as evidence that the current
> browser UI, layout, or accessibility behavior has been verified; refresh the
> screenshots before making current-browser claims.
