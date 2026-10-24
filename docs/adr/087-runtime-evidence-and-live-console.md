# ADR-087: Runtime evidence and live Console activity

## Status

Accepted.

## Context

Host execution and worker-container execution keep integrated task evidence in
the runtime data volume: a completion ledger plus content-addressed work,
validation and git-bundle artifacts. The Console's Artifacts view was
repository-scoped (`docs/artifacts/`), so it could not show this evidence.

The Console also mixed live service state with legacy repository files. Some
views refreshed only when an authoring job changed, so a service run could move
from queued to running to complete without an immediate UI update. Audit and
Timeline read `docs/EXECUTION-AUDIT.jsonl` rather than the service lifecycle.

## Decision

1. The execution service exposes read-only completion evidence:
   - `GET /v1/evidence?repositoryId=…` lists completion records.
   - `GET /v1/evidence/artifact?repositoryId=…&artifactId=…` resolves a work,
     validation or bundle artifact after checking it belongs to that
     repository's completion records.
2. The Console adds an **Evidence** view backed by those endpoints. The
   repository-local **Artifacts** view remains for files under
   `docs/artifacts/`; it is no longer treated as the source of service evidence.
3. The Console server polls the latest service run and derives snapshots from
   the authoritative run snapshot. Service status/task changes broadcast `snapshot`
   updates; run lifecycle events broadcast as live audit entries. Overview,
   Board, and Tasks consume the same service-run snapshot. Board durations are
   derived from service task timings, not a legacy audit file.
4. Validation is a shared execution concern. Host execution and the worker
   container use one validation implementation that installs missing project
   dependencies first, and the first validation result is published once as the
   task's validation artifact.
5. Agent path remapping is shared by host clones and worker worktrees so a
   manifest path inside the registered repository resolves in either execution
   mode.

## Consequences

- Evidence for worker and host runs is visible without copying files back into
  the repository or committing generated artifacts.
- The Console has one live source for run/task state and a separate live source
  for authoring/team/skills/manifest output.
- Worker execution no longer validates a dependency-free clone or validates
  twice.
- Artifact payloads remain runtime state. Cross-machine visibility still
  requires a runtime backup or future export.
