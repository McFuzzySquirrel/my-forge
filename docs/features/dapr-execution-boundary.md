# Feature: Dapr execution boundary and reusable contracts

**PRD:** [Foundation vision](../PRD.md)  
**Architecture decision:** [ADR-066](../adr/066-dapr-workflow-full-replacement-architecture.md)  
**Versioned contract:** [Dapr execution contract v1](../contracts/dapr-execution-v1.md)

## Overview

**ID Prefix:** DAPR-EXEC

**Dependencies:** Accepted P1-GATE and ADR-066.

**Gate status:** P2-GATE was accepted by the operator on 2026-10-13 in
[review issue #6](https://github.com/McFuzzySquirrel/my-forge/issues/6), after
the operator ran the review commands and confirmed the contracts, tests,
conformance fixtures, and migration notes. P3-GATE was accepted in
[issue #7](https://github.com/McFuzzySquirrel/my-forge/issues/7). P4-01 is
complete and tracked in
[issue #8](https://github.com/McFuzzySquirrel/my-forge/issues/8); local Dapr
timer/event recovery is recorded in the [roadmap](../../plan.md#p4-01-live-recovery-evidence).
The fixture proves workflow replay with test activities only. P4-02 is complete
under [issue #9](https://github.com/McFuzzySquirrel/my-forge/issues/9) and
[PR #10](https://github.com/McFuzzySquirrel/my-forge/pull/10), integrating
verification and compact handoffs. P4-03's reusable engine boundary now includes provider-neutral trusted-principal
approval authorization, durable PostgreSQL control records, validated task
resume activities, and run-control event workflows for pause/resume, graceful
stop, cancellation, and replay. The host supplies authoritative context,
idempotent process/control effects, and a trusted principal from its
authentication adapter; this repository does not yet provide a network identity
provider or production service host. Representative harness execution also
remains P4 work. P4-04 adds an application-owned PostgreSQL status projection
and sequenced, reconnectable lifecycle journal; it does not add a network
service host or Console integration. This P2 feature defines contracts and
reusable boundaries, not a production service.

**Scope:** P2 run/task identities, immutable submission snapshots, service/control
models, reusable execution boundaries, application-owned storage contracts,
conformance fixtures, and package/deployment ownership. This feature does not
implement a production Dapr service, change current engine behavior, or authorize
launcher/Console migration.

**Planned owners:** `dapr-contract-engineer` and `forge-runtime-engineer`; generate
the corresponding project team deliberately before compiling a runnable
manifest.

## Canonical requirements

```forge-requirement
{"id":"DAPR-EXEC-01","kind":"requirement","text":"Define a versioned run-submission contract with stable repository, target-ref, run, task, logical-attempt, operation, and manifest-digest identities; snapshot resolved task contracts, selection, harness/configuration versions, and workflow-definition version; deduplicate identical submission retries and reject key reuse with a different snapshot."}
```

```forge-requirement
{"id":"DAPR-EXEC-02","kind":"requirement","text":"Define versioned run/task status and control contracts for selection, pause, resume, graceful stop, cancellation, task replay, and human approval; distinguish requested, accepted, applied, and rejected controls, and never report acceptance as proof that a harness process has stopped."}
```

```forge-requirement
{"id":"DAPR-EXEC-03","kind":"requirement","text":"Extract harness invocation, request construction, task context, output/no-op checks, structured results, validation, artifact projection, and workspace utilities behind narrow interfaces that do not depend on the legacy scheduler or Dapr implementation."}
```

```forge-requirement
{"id":"DAPR-EXEC-04","kind":"requirement","text":"Define application-owned, versioned artifact-reference, operation-receipt, repository-fencing, and checkpoint-publication contracts with immutable digests, explicit state transitions, integrity checks, and retention that cannot delete data still referenced by a live run or review."}
```

```forge-requirement
{"id":"DAPR-EXEC-05","kind":"requirement","text":"Create runnable conformance fixtures for accepted P0 compatibility dispositions, including identity/deduplication, immutable snapshots, controls, task selection/replay, validation, at-least-once effects, artifact integrity, checkpoint publication, and repository fencing."}
```

```forge-requirement
{"id":"DAPR-EXEC-06","kind":"requirement","text":"Record package and deployment ownership before scaffolding: keep one managed Dapr service, a reusable Dapr-independent execution module, launcher-owned client and release packaging, and no accidental scheduler installation in each bootstrapped target repository."}
```

## Traceability

| ID | Owner / source | Relationship |
|---|---|---|
| DAPR-EXEC-01 through DAPR-EXEC-06 | This feature | owns |
| DAPR-C-01 through DAPR-C-04 | [Foundation vision](../PRD.md) | constrained by |
| P1 architecture and qualified versions | [ADR-066](../adr/066-dapr-workflow-full-replacement-architecture.md) | implements |

The normative field shapes, invariants, package boundaries, and conformance
matrix are in the [versioned contract](../contracts/dapr-execution-v1.md).
`plan.md` remains the status index; it does not duplicate these requirements.

## Phase 4: Reusable execution boundary

```forge-task
{
  "id":"P2-01",
  "title":"Define run submission and identity",
  "description":"Specify repository/target-ref, run, task, logical-attempt, operation, and manifest-digest identities. Define an immutable snapshot of the resolved manifest/contracts, selection, harness/configuration versions, and workflow-definition version. Retried submissions with the same idempotency key and snapshot return one run; incompatible reuse is rejected.",
  "ownerAgent":"dapr-contract-engineer",
  "dependencies":[],
  "expectedOutputs":["docs/contracts/dapr-execution-v1.md"],
  "validationCommands":["npm run validate-prd --prefix templates/skills/forge-execution-adapter -- ."],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-01"],
    "acceptanceCriteria":["The v1 identity and snapshot fields are normative and versioned.","Canonical digest and submission deduplication behavior are specified, including conflicting key reuse.","Snapshots contain secret references/version identifiers, never secret values."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-02"],
    "references":["plan.md","docs/adr/066-dapr-workflow-full-replacement-architecture.md"]
  }
}
```

```forge-task
{
  "id":"P2-02",
  "title":"Define service and control models",
  "description":"Specify run/task status queries, task selection, pause/resume/graceful stop/cancellation, task replay, approvals, and idempotent request acknowledgements. Keep scheduling acceptance separate from eventual process termination or effect application.",
  "ownerAgent":"dapr-contract-engineer",
  "dependencies":["P2-01"],
  "expectedOutputs":["docs/contracts/dapr-execution-v1.md"],
  "validationCommands":["npm run validate-prd --prefix templates/skills/forge-execution-adapter -- ."],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-02"],
    "acceptanceCriteria":["Every control has a defined request and acknowledgement lifecycle.","Graceful stop is distinct from immediate cancellation; explicit task replay allocates a new logical attempt.","Approval binds the operator decision to the run snapshot and evidence digests."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-04"],
    "references":["docs/adr/066-dapr-workflow-full-replacement-architecture.md","plan.md"]
  }
}
```

```forge-task
{
  "id":"P2-03",
  "title":"Separate reusable execution utilities",
  "description":"Extract existing harness adapters, request construction, task context, output/no-op checks, structured results, validation, artifact projection, and workspace utilities into the planned narrow execution boundary. Preserve the legacy engine as its caller by having launcher bootstrap stage the canonical utility library into the skill, without installing the Dapr scheduler. Avoid Dapr imports in the reusable interfaces and retain existing utility tests and behavior.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":["P2-01","P2-06"],
  "expectedOutputs":["tools/dapr-engine/execution/index.ts","tools/dapr-engine/package.json"],
  "validationCommands":["npm test --prefix templates/skills/forge-workflow-engine","npm run typecheck --prefix templates/skills/forge-workflow-engine","npm run typecheck --prefix tools/dapr-engine","npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-03"],
    "acceptanceCriteria":["Reusable execution APIs have no dependency on the old scheduler state machine or Dapr SDK.","All preserved legacy call paths use the extracted modules without semantic changes.","Launcher bootstrap stages the canonical execution library into the legacy skill and does not install a second scheduler.","The existing engine test suite and typecheck pass."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-02"],
    "references":["templates/skills/forge-workflow-engine/scripts/request.ts","templates/skills/forge-workflow-engine/scripts/task-context.ts","templates/skills/forge-workflow-engine/scripts/task-execution.ts","templates/skills/forge-workflow-engine/scripts/verify.ts","templates/skills/forge-workflow-engine/scripts/artifacts.ts","templates/skills/forge-workflow-engine/scripts/sandbox.ts","templates/skills/forge-workflow-engine/scripts/harness/run.ts"]
  }
}
```

```forge-task
{
  "id":"P2-04",
  "title":"Define storage and checkpoint contracts",
  "description":"Specify immutable artifact references and digests, operation receipt transitions, repository fencing, checkpoint publication and verification, schema versions, and retention. Keep all application-owned records separate from Dapr workflow internals.",
  "ownerAgent":"dapr-contract-engineer",
  "dependencies":["P2-02"],
  "expectedOutputs":["docs/contracts/dapr-execution-v1.md"],
  "validationCommands":["npm run validate-prd --prefix templates/skills/forge-execution-adapter -- ."],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-04"],
    "acceptanceCriteria":["Receipt compare-and-set transitions and ambiguous outcomes are explicit.","Artifact and checkpoint references are immutable and integrity-checked before publication.","Fencing prevents stale repository owners from accepting integration; retention preserves live references."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-02","docs/PRD.md#DAPR-C-04"],
    "references":["docs/adr/066-dapr-workflow-full-replacement-architecture.md","plan.md"]
  }
}
```

```forge-task
{
  "id":"P2-05",
  "title":"Build the execution conformance matrix",
  "description":"Turn the P0 compatibility register into runnable fixtures with exact expected results for run identity/deduplication, immutable snapshots, controls, selection/replay, validation, at-least-once effects, artifacts, checkpoints, and repository fencing. Use the repository's existing Node test runner; do not add a parallel test framework.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":["P2-02","P2-03","P2-04","P2-06"],
  "expectedOutputs":["tools/dapr-engine/tests/conformance/identity.test.ts","tools/dapr-engine/tests/conformance/controls.test.ts","tools/dapr-engine/tests/conformance/effects.test.ts","tools/dapr-engine/tests/conformance/matrix.test.ts","tools/dapr-engine/contract/v1/index.ts"],
  "validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-05"],
    "acceptanceCriteria":["Every intentional compatibility change has a fixture and a precise expected outcome.","Duplicate delivery and stale-owner cases prove no conflicting effect is accepted.","The normal package test command discovers and executes each named fixture."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-04"],
    "references":["plan.md","docs/contracts/dapr-execution-v1.md"]
  }
}
```

```forge-task
{
  "id":"P2-06",
  "title":"Choose package and deployment ownership",
  "description":"Record the service, reusable execution module, container resources, launcher client, build/release packaging, and bootstrap responsibilities before scaffolding runtime packages. Ensure a target repository receives no second scheduler through normal skill bootstrap.",
  "ownerAgent":"dapr-contract-engineer",
  "dependencies":["P2-04"],
  "expectedOutputs":["docs/contracts/dapr-execution-v1.md"],
  "validationCommands":["npm run validate-prd --prefix templates/skills/forge-execution-adapter -- ."],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-06"],
    "acceptanceCriteria":["One managed service owns Dapr Workflow and run controls.","The reusable execution boundary is Dapr-independent and has one documented owner.","Launcher release packaging/deployment and per-repository bootstrap responsibilities are explicit; bootstrap does not install another scheduler."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-03"],
    "references":["docs/adr/066-dapr-workflow-full-replacement-architecture.md","scripts/forge-launcher/scripts/resources.ts","scripts/forge-launcher/scripts/stage-resources.mjs"]
  }
}
```

```forge-task
{
  "id":"P2-GATE",
  "title":"Review the reusable execution boundary",
  "description":"Review the versioned contracts, runnable conformance fixtures, extracted utility tests, and package ownership. Record any unresolved compatibility or migration behavior explicitly. Do not treat contract design or legacy utility tests as proof of durable Dapr effects.",
  "dependencies":["P2-05","P2-06"],
  "expectedOutputs":[],
  "validationCommands":[],
  "contract":{
    "version":2,"kind":"human-review",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-execution-boundary.md#DAPR-EXEC-01","docs/features/dapr-execution-boundary.md#DAPR-EXEC-02","docs/features/dapr-execution-boundary.md#DAPR-EXEC-03","docs/features/dapr-execution-boundary.md#DAPR-EXEC-04","docs/features/dapr-execution-boundary.md#DAPR-EXEC-05","docs/features/dapr-execution-boundary.md#DAPR-EXEC-06"],
    "acceptanceCriteria":["Contracts are reviewed and versioned; extracted utilities retain passing tests; conformance fixtures run in the normal test command; intentional behavior changes have migration notes.","P3 remains blocked until this review is accepted."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-04"],
    "references":["plan.md","docs/contracts/dapr-execution-v1.md"],
    "reviewFile":"docs/reviews/dapr-p2.json"
  }
}
```

## Exclusions

Do not change current production commands, start the Dapr service for ordinary
repository bootstrap, migrate Console/launcher write authority, or claim
cancellation/retry/cross-host recovery qualification in P2. Those changes belong
to later contracts and gates.
