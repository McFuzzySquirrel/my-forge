# MyForge Dapr Replacement — Foundation PRD

## 1. Vision and scope

Replace MyForge's file-based orchestration with one Dapr Workflow engine that
supports local rootless Podman and hosted deployment profiles. Preserve canonical
requirements, manifest compilation, harness portability, verification, artifact
projection, and isolated Git integration.

This first increment owns the baseline review and runtime spike (P0/P1).
Production extraction, integration, client migration, retirement, and hosting
remain gated roadmap work in [the implementation tracker](../plan.md); author
their execution contracts only after the foundation gates pass. This is not a
manifest and must not be executed as authorization to retire the current engine.

## 2. Shared constraints

```forge-requirement
{"id":"DAPR-C-01","kind":"constraint","text":"Keep the existing production engine and its commands unchanged during the foundation increment; never permit both engines to write the same run or target branch."}
```

```forge-requirement
{"id":"DAPR-C-02","kind":"constraint","text":"Use released SDK and runtime APIs; keep workflow code deterministic and use activities for nondeterministic effects. Do not invent a workflow transport or assume independent JavaScript activity application support."}
```

```forge-requirement
{"id":"DAPR-C-03","kind":"constraint","text":"Use rootless local containers with private infrastructure ports, persistent database/Scheduler/artifact volumes, scoped generated credentials, and no host-home or container-engine socket mounts. Stop must preserve data; destructive reset requires explicit confirmation."}
```

```forge-requirement
{"id":"DAPR-C-04","kind":"constraint","text":"Do not fabricate gate approval, passing live checks, or cross-host recovery evidence. A skipped live test blocks its gate; single-host volume persistence is not high availability."}
```

## 3. Technical direction

Prefer a single TypeScript workflow application. Decide against pinned releases,
not unreleased documentation. PostgreSQL actor state and persistent Scheduler
storage are separate durability concerns. The spike uses stub work only, not
real repository mutation or paid model calls. Defer Dapr Agents and independent
worker applications.

Acceptance budgets in the tracker are proposals requiring operator approval,
not already agreed service-level objectives. No implementation agent may approve
the human-review tasks below.

## 14. Features

| # | Feature | File | Dependencies |
|---|---|---|---|
| 1 | Dapr foundation and runtime spike | [features/dapr-foundation.md](features/dapr-foundation.md) | None |

## 15. Traceability and rollout

The feature owns foundation requirements and executable gate/spike tasks.
`plan.md` owns work-package status and evidence links, not a duplicate requirement
catalogue. P2–P8 remain blocked until their predecessor gates pass. Planned
specialist names in feature contracts must be generated deliberately before
compiling a runnable manifest; this increment does not generate an agent team.
