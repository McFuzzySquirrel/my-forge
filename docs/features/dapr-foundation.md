# Feature: Dapr foundation and runtime spike

**PRD:** [Foundation vision](../PRD.md)

## Overview

**ID Prefix:** DAPR-FOUND

**Dependencies:** None

**Scope:** P0 evidence and review, followed by an isolated P1 stub runtime.
Specialist owner `dapr-runtime-engineer` is planned, not an installed agent.

## Canonical requirements

```forge-requirement
{"id":"DAPR-FOUND-01","kind":"requirement","text":"Record the existing execution semantics and authority/caller inventory with source/test references, baseline commands/results, and explicit compatibility dispositions before production replacement."}
```

```forge-requirement
{"id":"DAPR-FOUND-02","kind":"requirement","text":"Require operator review of baseline failures, compatibility decisions, measurable local/recovery budgets, and harness/validation trust boundaries before accepting the P0 gate."}
```

```forge-requirement
{"id":"DAPR-FOUND-03","kind":"requirement","text":"Verify and pin released runtime, JavaScript Workflow SDK, Node, Podman, state component, and container versions; validate workflow registration, activities, timers, external events, status, history replay, and shutdown using the published APIs."}
```

```forge-requirement
{"id":"DAPR-FOUND-04","kind":"requirement","text":"Provide an isolated rootless Podman stub spike with persistent PostgreSQL actor state, Scheduler storage, and artifact volume; recreate application/sidecar and restart the stack without deleting state."}
```

```forge-requirement
{"id":"DAPR-FOUND-05","kind":"requirement","text":"Record real timer/approval recovery and activity outcomes for the same workflow instance, host resource/readiness/offline observations, and nonzero failures when required infrastructure is unavailable."}
```

```forge-requirement
{"id":"DAPR-FOUND-06","kind":"requirement","text":"Accept the P1 architecture/language decision only after released-support and live durability evidence pass approved budgets; missing evidence blocks production replacement."}
```

## Traceability

| ID | Owner / source | Relationship |
|---|---|---|
| DAPR-FOUND-01 through DAPR-FOUND-06 | This feature | owns |
| DAPR-C-01 through DAPR-C-04 | [Vision](../PRD.md) | participates |

P0-01 through P0-05 produce the baseline/caller/compatibility/test evidence in the
tracker. P0-06 is operator agreement of budgets, not autonomous approval. These
preparation work packages are reviewed by the single P0-GATE below. P1-01/P1-02
map to RELEASE verification; P1-03 maps to STACK; P1-04/P1-05 map to RECOVERY;
P1-06 and P1-GATE map to the dependent human decision. The task dependencies,
not descriptive roadmap status, are the execution authorization boundary.

## Phase 1: Baseline acceptance

```forge-task
{
  "id":"P0-GATE",
  "title":"Accept foundation baseline and budgets",
  "description":"Review the P0 inventories, baseline failures, compatibility dispositions, and proposed thresholds in plan.md. Confirm owner assignment and execution/trust scope. Do not approve unmeasured baselines or silently waive failures; explicitly document any accepted pre-existing limitation. This is operator work, not a model task.",
  "dependencies":[],
  "expectedOutputs":[],
  "validationCommands":[],
  "contract":{
    "version":2,"kind":"human-review",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-foundation.md#DAPR-FOUND-01","docs/features/dapr-foundation.md#DAPR-FOUND-02"],
    "acceptanceCriteria":["Baseline package results and source/test inventories are inspectable.","Compatibility decisions and budgets have an identified human approver; any open baseline failure has an explicit disposition.","P0-01 through P0-06 are accepted before authorizing P1 execution."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-04"],
    "references":["plan.md#P0 evidence — 2026-10-13"],
    "reviewFile":"docs/reviews/dapr-p0.json"
  }
}
```

## Phase 2: Released support and local spike

```forge-task
{
  "id":"P1-RELEASE",
  "title":"Verify released Workflow support",
  "description":"Inspect the released JavaScript SDK exports and runtime compatibility. Pin versions for the isolated tools/dapr-spike entry point and record official release references and missing capabilities. Keep the orchestration language decision provisional if a required feature is unverified; do not substitute a custom protocol.",
  "ownerAgent":"dapr-runtime-engineer",
  "dependencies":["P0-GATE"],
  "expectedOutputs":["tools/dapr-spike/package.json","tools/dapr-spike/package-lock.json","plan.md"],
  "validationCommands":["npm run typecheck --prefix tools/dapr-spike","npm test --prefix tools/dapr-spike"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-foundation.md#DAPR-FOUND-03"],
    "acceptanceCriteria":["Published SDK entry points implement registration, activities, timers, external events and status without a private transport.","Exact dependency versions and known runtime limitations are recorded; unit tests discover and execute named cases."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-02"],
    "references":["docs/research/dapr-workflow-and-agents.md"]
  }
}
```

```forge-task
{
  "id":"P1-STACK",
  "title":"Run a persistent rootless spike stack",
  "description":"Provide the tools/dapr-spike lifecycle entry point with a stub workflow/activity worker and explicit application/sidecar, Placement, Scheduler, PostgreSQL actor state and artifact storage. Preserve volumes on stop; keep credentials out of tracked files and infrastructure ports private. This does not execute Forge manifests or mutate user repositories.",
  "ownerAgent":"dapr-runtime-engineer",
  "dependencies":["P1-RELEASE"],
  "expectedOutputs":["tools/dapr-spike/package.json","plan.md"],
  "validationCommands":["npm run typecheck --prefix tools/dapr-spike","npm test --prefix tools/dapr-spike"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-foundation.md#DAPR-FOUND-04"],
    "acceptanceCriteria":["Lifecycle and worker entry points are reachable through documented package commands.","Tests cover destructive-operation confirmation and state-preserving stop; live durability is reserved for the dependent review."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-01","docs/PRD.md#DAPR-C-03"],
    "references":["docs/research/dapr-workflow-and-agents.md"]
  }
}
```

## Phase 3: Live qualification and architecture decision

```forge-task
{
  "id":"P1-GATE",
  "title":"Qualify live recovery and approve the architecture",
  "description":"Run the spike on the approved Linux rootless host. Exercise activity output, durable timer and approval waits, then application/sidecar and stack restarts for the same workflow. Inspect actual non-empty status/results, persistent volume integrity, readiness/resource/offline observations and failure behavior. Approve P1-06 only when the approved P0 budgets and released support pass; record any block instead of fabricating an ADR acceptance.",
  "dependencies":["P1-STACK"],
  "expectedOutputs":[],
  "validationCommands":[],
  "contract":{
    "version":2,"kind":"human-review",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-foundation.md#DAPR-FOUND-05","docs/features/dapr-foundation.md#DAPR-FOUND-06"],
    "acceptanceCriteria":["Live evidence proves the same run resumes its timer/approval waits after both restart scopes with no manual state edits.","Measured resources/recovery match operator-approved thresholds and cached stub execution succeeds without provider access.","Approve or reject the language/topology decision explicitly; P2 stays blocked until approval."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-02","docs/PRD.md#DAPR-C-03","docs/PRD.md#DAPR-C-04"],
    "references":["plan.md","tools/dapr-spike/package.json","docs/research/dapr-workflow-and-agents.md"],
    "reviewFile":"docs/reviews/dapr-p1.json"
  }
}
```

## Testing and exclusions

Existing package tests establish regression baselines. Spike unit/type checks
do not establish Dapr durability; P1-GATE requires live persisted history and
output evidence. Never produce human review JSON as an agent deliverable.
Future production features require their own contracts and tests after approval.
The current team must be generated to match planned owners before compilation.
