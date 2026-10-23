# Architecture

MyForge is a local-first authoring and execution toolchain. Requirements and agent
instructions are authored in a target repository, then
`forge-execution-adapter` compiles them into an execution manifest. The launcher
submits that manifest to the registered local Dapr execution service; the
service, not the launcher or Console, owns durable run orchestration and status.

For the detailed, code-grounded component map, data flow, runtime topology,
testing boundaries, and extension guidance, see the
[Project Architecture Blueprint](Project_Architecture_Blueprint.md).
For the current Dapr-backed service-run lifecycle, see the
[Local Execution Architecture](docs/local-execution.md) and its
[code-grounded deep dive](docs/local-execution-deep-dive.md).

## Core components

- **Launcher** (`scripts/forge-launcher/`): cross-platform CLI, bootstrap and
  authoring orchestration, local runtime lifecycle, service API client, and
  loopback Console.
- **Authoring templates** (`templates/skills/`, `templates/agents/`):
  human-reviewed PRD and feature authoring followed by reproducible team and
  project-skill derivation.
- **Execution adapter** (`templates/skills/forge-execution-adapter/`):
  validates source documents and compiles `docs/EXECUTION-MANIFEST.json`.
- **Dapr execution service** (`tools/dapr-engine/`): service API, durable Dapr
  workflows, task/harness execution, PostgreSQL-backed run records, and
  file-backed artifacts/checkpoints.
- **Local runtime** (`tools/dapr-engine/deploy/`): rootless Podman Compose
  deployment for PostgreSQL, Dapr placement/Scheduler/sidecar, and the Forge
  worker. Registered repositories are mounted by the launcher.
- **Forge Console** (`scripts/forge-launcher/scripts/console/`): local browser
  projection for authoring, service-run status and controls, logs, artifacts,
  tasks, and the Console-owned Kanban/Gantt Board.
- **Legacy workflow-engine skill**: a fail-closed compatibility reference;
  it is not an execution scheduler. The canonical Dapr-independent execution
  library is owned by `tools/dapr-engine/execution/`.

## Runtime data flow

1. The launcher creates or selects a target repository and bootstraps harness
   templates.
2. Interactive authoring produces reviewed PRD and feature documents; team and
   skill derivation follow those approved requirements.
3. The execution adapter validates inputs and writes the manifest.
4. The launcher authenticates to the local service API and submits a run
   snapshot for a registered repository.
5. Dapr Workflow coordinates durable run/task activities. PostgreSQL stores
   submissions, statuses, events, controls, receipts, and execution ownership;
   the worker uses the execution library and granted harness credentials.
6. The service integrates task changes into the repository. The Console reads
   service-backed status and exposes acknowledged controls; legacy
   `WORKFLOW-STATE.json` remains archival and is not execution authority.

## Architectural boundaries

- Requirements, compilation, execution, and UI projection have separate
  owners. Execution consumes the compiled manifest, not the PRD.
- `tools/dapr-engine/contract/v1/` defines Dapr-independent application
  contracts; `execution/` implements the reusable task/harness boundary.
- Dapr orchestration and persistence live in `tools/dapr-engine/`; launcher
  service clients and runtime management live in `scripts/forge-launcher/`.
- The local service API is loopback-only and bearer-token protected.
  Repository registration controls which project Git metadata the worker can
  access; harness credentials are granted separately.
- Hosted execution is not available. New runs require local runtime
  registration; legacy histories are not imported or silently resumed.

## Repository layout

- [templates](templates) — reusable agents, skills, and execution-manifest
  compiler.
- [scripts](scripts) — launcher package and shell/PowerShell compatibility
  wrappers.
- [tools/dapr-engine](tools/dapr-engine) — execution contracts, reusable
  execution library, Dapr service, storage adapters, and deployment files.
- [docs](docs) — user guidance, deep dives, ADRs, release notes, and contracts.
- [README.md](README.md) — project landing page and quick start.

## Design principles

- **PRD-first** — review requirements before implementation.
- **Explicit contracts** — compile a manifest and version durable run contracts.
- **One execution authority** — the registered Dapr service owns supported run
  state; do not add legacy fallback writers.
- **Human review boundaries** — automate mechanical derivation, not requirement
  decisions.
- **Local-first, not hosted** — the current runtime is an operator-managed local
  Podman deployment, not a hosted multi-tenant control plane.
