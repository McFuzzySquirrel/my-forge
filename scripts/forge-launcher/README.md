# forge-launcher

One command from zero to auto-build. `forge-launcher` is the cross-platform
Node.js entry point for [MyForge](https://github.com/McFuzzySquirrel/my-forge) -
it creates a repo, bootstraps the agent/skill templates, captures your idea, and
drives the pipeline from PRD → agent team → autonomous build.

> Requires **Node.js 18+**.

## Install

```bash
npm install -g forge-launcher
# or, without a global install:
npx forge-launcher
```

## Quick start

```bash
forge-launcher            # interactive: create a repo, bootstrap templates, capture your idea
```

Answer the prompts, then open the generated repo in your agent harness and run
the queued command it prints.

## Commands

| Command | What it does |
|---|---|
| `forge-launcher` | Interactive onboarding: repo → bootstrap → idea → queue the next stage. |
| `forge-launcher --draft` | Same, but auto-draft the agent team and project skills (keeps review boundaries). The PRD is always interactive. |
| `forge-launcher --headless` | Drive the queued skill from the terminal via `opencode run --auto` / `copilot -p --yolo`. Stops with a handoff when no PRD exists. |
| `forge-launcher bootstrap <dir> [--harness agents\|github\|claude\|opencode]` | Copy agent/skill templates into an existing project. |
| `forge-launcher engine-run [--repo <path>] [--harness <h>] …` | Compile the manifest and run the autonomous build through the local Dapr service. The repository must be registered with `runtime repo add` and the runtime restarted. |
| `forge-launcher resume [--repo <path>]` | Pick up a paused/finished setup where it left off; build execution requires a registered repository and uses the local service. |
| `forge-launcher console [--repo <path>]` | Local web UI (`http://127.0.0.1:4300`) for authoring, build monitoring, service-run controls, and full local runtime administration; sign in with the printed single-use link. |
| `forge-launcher runtime start [--host-tools]` | Start the Forge worker and persistent PostgreSQL/Dapr services with rootless Podman; host tools publish PostgreSQL on loopback only. |
| `forge-launcher runtime status` | Show runtime containers and recent logs for unhealthy or stopped services. |
| `forge-launcher runtime stop` | Stop containers while preserving persistent volumes. |
| `forge-launcher runtime rotate-tokens` | Replace the service API and Dapr sidecar tokens (database passwords are kept); restart the runtime to apply. |
| `forge-launcher runtime reset --confirm` | Stop the runtime and remove its persistent volumes after explicit confirmation. |
| `forge-launcher runtime backup --output <new-directory>` | Quiesce the runtime and write checksummed PostgreSQL, Scheduler, and Forge volume archives. |
| `forge-launcher runtime restore --from <backup-directory> --confirm` | Verify an archive, replace runtime volumes, and restart the service. |
| `forge-launcher runtime repo add <path> [--id <id>] \| list \| remove <id>` | Register repositories whose `.git` directory the service may mount; restart to apply. All repositories in one runtime share a trust domain, so register only mutually trusted projects. |
| `forge-launcher runtime harness grant <harness> <VARIABLE> [--from-env] \| list \| revoke <harness> [VARIABLE]` | Grant, list, or revoke the credentials a worker harness (`copilot`, `claude`, `opencode`) receives; values are read from stdin or the environment. |
| `forge-launcher service submit [--repo <path>] [--follow] ...` | Submit the compiled manifest to the local service; it integrates into `forge/<branch>`. |
| `forge-launcher service runs \| status \| events \| control \| merge` | List, monitor, control, and fast-forward-merge service runs; `--json` exports run records and the event audit trail. |
| `forge-launcher draft-team \| draft-skills [--repo <path>]` | Headless derivation stages (PRD → agent team → project skills). |
| `forge-launcher draft-prd \| draft-existing-prd [--repo <path>]` | Report the interactive requirements handoff. The PRD is never authored headlessly — see [ADR-060](../../docs/adr/060-interactive-requirements-authoring.md). |
| `forge-launcher compile-manifest [--repo <path>]` | Headless build-prep stage: install the adapter if needed and write `docs/EXECUTION-MANIFEST.json` without submitting a run. |

Bootstrap includes the canonical Dapr-independent execution utilities in the
retired workflow-engine compatibility package; it does not install or restore
the legacy scheduler. The launcher-managed Dapr service runs outside the target
repository and is provisioned with `forge-launcher runtime start`.

The `runtime` commands manage the local service and its infrastructure. The
`service` commands use its loopback, token-authenticated run API. The worker
image includes pinned `copilot`, `claude`, and `opencode` CLIs, which run only
with credentials granted through `runtime harness grant`. The Console's
**Runtime** view manages lifecycle, repository registration, backups, token
rotation, and harness grants; destructive actions require confirmation, and
registration changes require a separate restart. For registered repositories,
`engine-run`, `resume`, and Console builds and controls use the service.
Unregistered repositories fail closed; legacy workflow histories are not
imported. See the [cutover and rollback procedure](../../docs/forge-launcher.md#cut-over-from-the-legacy-engine)
and [ADR-079](../../docs/adr/079-dapr-execution-cutover.md).

For an unpublished checkout, run `npm install`, `npm pack`, and
`npm install -g ./forge-launcher-1.0.0-beta.6.tgz` in this package directory.
Packing bundles the service source and its ES module package metadata.
See the [local installation guide](../../docs/forge-launcher.md#install-locally-before-publishing).

In the Console's **Projects** view, use **Remove from Forge** for one project or
**Remove selected (N)** for several. Confirmation is required. Only Forge
registration, Console job history, and verified external job-result files are
removed; no files inside project folders are changed or deleted. Active jobs
block removal. Existing folders can be added again without bootstrapping.

### Autonomous build

```bash
forge-launcher engine-run --harness opencode --yes                 # per-task: opencode run
forge-launcher engine-run --harness copilot --yes                  # per-task: copilot -p --yolo
forge-launcher engine-run --harness opencode --concurrency 3 --yes # parallel dispatch
forge-launcher engine-run --stop    # stop an active service run after the current task
forge-launcher engine-run --pause   # pause an active service run after the current task
```

Use `forge-launcher console` to monitor and control service runs in the Console,
including the Kanban/Gantt Board. The service ignores legacy `engine-run`
options for task timeout, heartbeat, visualization, validation, harness-output
logging, and auto-commit; `forge-launcher engine-run --help` lists the supported
service behavior.

OpenCode v2 is required. The former `--keep-alive`, `--keep-alive-port`,
`--no-keep-alive`, and `--attach` flags are retired (see
[ADR-058](../../docs/adr/058-opencode-v2-project-resolution.md)); each
`opencode run` connects to OpenCode's own warm background service, so there is no
server to manage. Set `OPENCODE_EXTRA_FLAGS=--standalone` for a private
per-run server.

## Harnesses

MyForge works with any harness that reads agents and skills from a repo:
GitHub Copilot (`.github/agents/`), Claude Code (`.claude/agents/`), opencode
(`.opencode/agents/`), or a generic `.agents/` directory. Service-backed builds
support `opencode`, `copilot`, and `claude`, plus `stub` for token-free
testing.

## Docs

- [Full project README](https://github.com/McFuzzySquirrel/my-forge#readme)
- [Launcher reference](https://github.com/McFuzzySquirrel/my-forge/blob/main/docs/forge-launcher.md)
- [Forge Console](https://github.com/McFuzzySquirrel/my-forge/blob/main/docs/forge-console.md)
- [Legacy workflow-engine reference](https://github.com/McFuzzySquirrel/my-forge/blob/main/docs/workflow-engine.md)
