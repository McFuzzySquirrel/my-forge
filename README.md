# MyForge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=fff)
![Dapr](https://img.shields.io/badge/Dapr-execution-0D2192?logo=dapr&logoColor=fff)
![Local-first](https://img.shields.io/badge/local--first-operator%20managed-2F6F4E)
![Rootless Podman](https://img.shields.io/badge/Podman-rootless-892CA0)

> MyForge turns an idea into a reviewed PRD, a specialist agent team, and an autonomous build.

**Latest: v3.159** — see [docs/updates.md](docs/updates.md) for release notes.

MyForge is a PRD-first workflow for turning product requirements into working software. It combines structured planning, agent-based implementation, and execution orchestration in one path so a project can move from concept to build without losing the review checkpoints that matter.

Every solution uses a PRD and one or more canonical feature documents.
Requirements and tasks have one owning location; compact task contracts resolve
shared IDs into complete execution instructions. Legacy source documents must be
converted before building. See [Canonical Features](docs/canonical-features.md).

## Highlights

- Keeps the PRD as the quality gate before implementation begins.
- Generates a specialist agent team from the PRD instead of relying on a single generic assistant.
- Supports guided, interactive authoring and unattended service-backed builds.
- Includes a local web console for authoring, live run monitoring, durable task
  evidence, and complete local runtime administration.
- Supports two Dapr-backed harness execution modes: native host execution is
  the temporary default and uses your locally installed CLI and normal
  authentication; the worker container uses runtime-provided CLIs and granted
  credentials. Both remain explicit per-run choices.
- Native-host execution is unsandboxed, runs with the logged-in user's full OS
  permissions, and never silently falls back to worker-container execution.
- Keeps completion evidence, validation results, and Git bundles across runs so
  later builds can replay already-integrated tasks instead of paying for them again.
- Can bootstrap MyForge into an existing Git repository without replacing its application code.

## Architecture and current status

MyForge is local-first. The supported build path compiles authored requirements
with `forge-execution-adapter`, submits an immutable snapshot to the local Dapr
execution service, and lets Dapr own workflow state, task controls, validation,
checkpoints, completion evidence and Git integration.

A task's harness can run in two explicit locations:

- **Native host runner (temporary default):** a launcher-managed process invokes
  your locally installed, locally authenticated CLI with your full OS
  permissions. It is not sandboxed and never silently falls back to the worker.
- **Worker container:** the pinned CLI runs inside the Forge worker with
  credentials granted through `forge-launcher runtime harness grant`. Select it
  in the Console or pass `--worker-execution` to opt out for a run.

The Forge Console reads service-backed run status and lifecycle events live,
and reads durable work/validation/bundle evidence from the service. Authoring,
team, skills and manifest activity is written to `docs/forge.log`; the native
host-runner log is separate.

The pre-Dapr workflow engine and its `engine-run` CLI have been removed. Use
`forge-launcher run` (or `forge-launcher service submit`). Existing
`WORKFLOW-STATE.json`, `engine-control.json`, `engine.pid` and
`docs/engine-run.log` files are ignored for execution; `docs/engine-run.log`
remains readable as legacy history.

**Status:** P7 cutover is complete. The Linux rootless profile is qualified for
stub, Copilot and OpenCode. The native host runner is implemented, but HR-04
live-runtime/host-OS qualification and HR-GATE remain pending; native
macOS/Windows and Claude are unqualified. Hosted deployment (P8) has not
started.

See the [architecture blueprint](Project_Architecture_Blueprint.md),
[local execution overview](docs/local-execution.md),
[implementation tracker](plan.md), and
[runtime backup and rollback procedure](docs/forge-launcher.md#rollback).

![Forge Console live walkthrough](docs/images/forge-console/current/console-walkthrough.gif)

See the [Forge Console visual tour](docs/forge-console-screenshots.md) for
the full screenshot walkthrough, including current responsive captures.

## Quick start

### Prerequisites

- Node.js 18+
- Git
- A compatible harness CLI for interactive authoring. Native host execution is
  the temporary default and requires that CLI to be installed and authenticated
  locally; the explicit worker-container mode uses runtime-provided CLIs and
  runtime-granted credentials.
- **Rootless Podman** with a Compose provider for the local Dapr execution
  service. Podman runs the worker container, PostgreSQL, Dapr, and the runtime
  data volumes. Even native-host runs require the local service runtime.

#### Install Podman

- **Linux:** [Install Podman for your distribution](https://podman.io/docs/installation#linux-distributions).
  Confirm rootless mode with `podman info`; see the upstream
  [rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
  if user namespaces or subuid/subgid mappings need configuration.
- **macOS:** [Install Podman](https://podman.io/docs/installation#macos),
  then create and start the Podman machine:

  ```bash
  podman machine init
  podman machine start
  ```

- **Windows:** [Install Podman](https://podman.io/docs/installation#windows)
  with WSL2, then create and start the Podman machine:

  ```bash
  podman machine init
  podman machine start
  ```

  The upstream [Podman for Windows guide](https://github.com/podman-container-tools/podman/blob/main/docs/tutorials/podman-for-windows.md)
  covers WSL2 and machine setup in more detail.
- **GUI option:** [Podman Desktop](https://podman-desktop.io/downloads) can
  install and manage Podman on macOS and Windows.

Verify the runtime prerequisites before starting the service:

```bash
podman info
podman compose version
```

A Compose provider such as `podman-compose` must be available. MyForge currently
qualifies the Linux rootless profile. macOS and Windows use a Podman machine;
those native-host execution profiles remain unqualified in this release.

### Option 1: Run from a clone

```bash
git clone https://github.com/McFuzzySquirrel/my-forge.git
cd my-forge/scripts/forge-launcher
npm install
npm run build
```

The shell wrapper delegates to the built Node package and remains available for
compatibility with existing workflows for one release after the package
migration. For new usage, run the package directly from `scripts/forge-launcher`;
when the package is available from your registry, use `npx forge-launcher@beta console`.

### Option 2: Install the npm package from source

The npm package is not published yet, but the current pre-release is
`forge-launcher@1.0.0-beta.6`. You can install it locally from this repository:

```bash
git clone https://github.com/McFuzzySquirrel/my-forge.git
cd my-forge/scripts/forge-launcher
npm install
npm pack
npm install -g ./forge-launcher-1.0.0-beta.6.tgz
```

### Start the runtime and open the Console

Start the local runtime once before the first service-backed build, then open the
Console:

```bash
forge-launcher runtime start
forge-launcher runtime status
forge-launcher console
```

For the checkout directly:

```bash
node dist/cli.js runtime start
node dist/cli.js runtime status
node dist/cli.js console
```

The **Forge Console** is the recommended entry point. It opens the local Console
and its single-use sign-in link. Create or open a project, author the PRD and
features, and monitor and control builds there. The interactive terminal launcher
is still available as `forge-launcher` if you prefer prompts in the terminal.

For the manual prompting flow and the CLI's expected prompts, see
[docs/prompt-playbook.md](docs/prompt-playbook.md). For the latest changes and
release notes, see [docs/updates.md](docs/updates.md).

> [!NOTE]
> The canonical launcher runtime lives in [scripts/forge-launcher](scripts/forge-launcher).
> The shell wrappers are deprecated compatibility shims retained for one release
> after the package migration.

## How it works

1. Capture your idea and review the PRD and feature contracts.
2. Generate the agent team, project skills, and execution manifest.
3. Run the build through the local Dapr execution service, using the native host
   runner (the temporary default) or the explicit worker container.
4. Review live run status, logs, and durable evidence in the Console or with
   `forge-launcher service`.

## Main components

- `forge-launcher` — onboarding, interactive authoring, manifest submission,
  runtime lifecycle, service client, and Console.
- `forge-execution-adapter` — compiles the authored plan into the execution
  manifest consumed by the service.
- Dapr execution service — durable orchestration, task controls, validation,
  checkpointing, completion replay, and Git integration.
- Native host runner and worker container — the two explicit harness locations;
  host execution is the temporary default.
- Runtime evidence store — completion records plus content-addressed work,
  validation, and [Git-bundle](docs/git-bundle-evidence.md) artifacts.
- Forge Console — a local web UI for authoring, live service-run monitoring,
  logs, task evidence, and runtime administration.

## Documentation

- [Local execution architecture](docs/local-execution.md)
- [Long-running projects and phase-by-phase operation](docs/long-running-projects.md)
- [Local execution deep dive](docs/local-execution-deep-dive.md)
- [Task contracts](docs/task-contracts.md)
- [Forge Launcher reference](docs/forge-launcher.md)
- [Forge Console reference](docs/forge-console.md)
- [Forge Console user guide](docs/forge-console-user-guide.md)
- [Harness credentials and execution boundaries](docs/harness-credentials.md)
- [Canonical features](docs/canonical-features.md)
- [Prompt playbook](docs/prompt-playbook.md)
- [Release notes](docs/updates.md)
- [Architecture overview](ARCHITECTURE.md)
- [Project Architecture Blueprint](Project_Architecture_Blueprint.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
cd scripts/forge-launcher
npm install
npm test
npm run typecheck
npm run build
npm run check:version

cd ../../tools/dapr-engine
npm test
npm run typecheck
```
