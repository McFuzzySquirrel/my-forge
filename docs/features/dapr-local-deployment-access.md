# Feature: Dapr local deployment and access profiles

**PRD:** [Foundation vision](../PRD.md)  
**Architecture decision:** [ADR-068](../adr/068-local-deployment-and-access-profiles.md)  
**Roadmap:** [P5](../../plan.md#p5--migrate-the-launcher-console-and-local-lifecycle), P8-02

## Overview

**ID Prefix:** DAPR-DEPLOY

**Dependencies:** Accepted P4-GATE; Dapr execution boundary and reusable contracts.

**Scope:** The persistent local Compose stack, how it handles ports and
credentials, the harness-independent local operator session, and the design of
GitHub-based shared access. Only the local profile is delivered in P5. Shared
access is implemented and qualified only under P8.

**Planned owners:** `forge-runtime-engineer` and `dapr-contract-engineer`; generate
the corresponding project team deliberately before compiling a runnable
manifest.

## Canonical requirements

```forge-requirement
{"id":"DAPR-DEPLOY-01","kind":"requirement","text":"Distribute a persistent launcher-owned Podman Compose stack containing PostgreSQL, Dapr sidecar, Placement, and Scheduler with pinned versions, readiness ordering, restart policy, resource limits, and separate named volumes. Stop and recreation preserve durable data; reset is a separate confirmed destructive action."}
```

```forge-requirement
{"id":"DAPR-DEPLOY-02","kind":"requirement","text":"Keep PostgreSQL and other infrastructure ports private by default. An optional host-tools override may publish only 127.0.0.1:${POSTGRES_PORT:-55432}:5432; a port conflict fails with a clear error instead of silently choosing another endpoint. Containers use service DNS. The test Compose file and its volume remain separate from user runtime data."}
```

```forge-requirement
{"id":"DAPR-DEPLOY-03","kind":"requirement","text":"Separate Dapr-owned state from application-owned tables using distinct databases or schemas and narrowly scoped roles; generate credentials once into protected untracked installation storage, reuse them on restart, and never expose them to harness environments or task workspaces."}
```

```forge-requirement
{"id":"DAPR-DEPLOY-04","kind":"requirement","text":"Provide a local operator session for single-user installations that trusts the local OS account, exchanges a one-time bootstrap capability for an expiring browser session, authenticates reads, artifacts, events, and controls, validates Host/Origin/CSRF, and requires no GitHub, gh, Copilot, harness, or GitHub App login. Standalone use without collaborators is first-class."}
```

```forge-requirement
{"id":"DAPR-DEPLOY-05","kind":"requirement","text":"For shared deployments (P8 only), authenticate collaborators with GitHub App user sign-in rather than an ambient browser, gh, or harness login. Authorize by both app installation on the repository and the user's current repository permission: read/triage may view; write/maintain/admin may submit, control, and approve. Host administration is configured separately; revocation fails closed."}
```

```forge-requirement
{"id":"DAPR-DEPLOY-C-01","kind":"constraint","text":"Do not implement Forge passwords, treat ambient GitHub/gh/harness/Git identity as an authenticated remote Forge session, bind non-loopback without a qualified shared profile, or claim hosted availability before P8 qualification."}
```

## Traceability

| ID | Owner / source | Relationship |
|---|---|---|
| DAPR-DEPLOY-01 through DAPR-DEPLOY-05 | This feature | owns |
| DAPR-DEPLOY-01, -02, -03 | P5-01 in [plan.md](../../plan.md) | implemented by |
| DAPR-DEPLOY-04 | P5-02 and P5-05 in [plan.md](../../plan.md) | implemented by |
| DAPR-DEPLOY-05 | P8-02 in [plan.md](../../plan.md) | implemented by |
| DAPR-C-03 | [Foundation vision](../PRD.md) | constrained by (loopback host-tools exception recorded in ADR-068) |
| Trusted-principal approvals | [Contract v1](../contracts/dapr-execution-v1.md) | consumes |

`plan.md` remains the status index; it does not duplicate these requirements.

## Phase 5: Local deployment and access

**P5-01 owner:** @McFuzzySquirrel. **Tracking:** [issue #16](https://github.com/McFuzzySquirrel/my-forge/issues/16).

```forge-task
{
  "id":"P5-01",
  "title":"Package the persistent local stack",
  "description":"Create launcher-distributed Compose resources from tools/dapr-engine sources, staged by stage-resources.mjs: PostgreSQL, Dapr sidecar, Placement, and Scheduler with pinned versions, readiness ordering, restart policy, resource limits, and separate named volumes. Keep internal ports private; add an optional host-tools override publishing only 127.0.0.1:${POSTGRES_PORT:-55432}:5432 and fail clearly on port conflicts. Separate Dapr and application databases/roles; generate credentials once into protected untracked storage. Retain compose.postgres.yaml as the separate test database.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":[],
  "expectedOutputs":["tools/dapr-engine/deploy/compose.yaml","tools/dapr-engine/deploy/compose.host-tools.yaml","scripts/forge-launcher/scripts/stage-resources.mjs"],
  "validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine","npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-01","docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-02","docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-03"],
    "acceptanceCriteria":["Compose renders with the supported Podman provider and readiness succeeds.","Internal ports stay unpublished; the optional override publishes PostgreSQL on loopback only and a conflicting port fails with a clear error.","Stop and container recreation preserve durable state; missing credentials fail without leaking secrets.","The test Compose file and its volume are unchanged and never attached to runtime data."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-03","docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-C-01"],
    "references":["plan.md","docs/adr/068-local-deployment-and-access-profiles.md","tools/dapr-engine/compose.postgres.yaml","tools/dapr-engine/scripts/support/dapr-stack.ts"]
  }
}
```

```forge-task
{
  "id":"P5-02",
  "title":"Add local service lifecycle",
  "description":"Compose existing orchestration, stores, status projection, and approval coordinator behind a production service entry point with launcher-owned start/status/stop and diagnostics. Stop preserves volumes; reset is a separate confirmed action. Define migration/version checks and backup/restore hooks covering all stores.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":["P5-01"],
  "expectedOutputs":["tools/dapr-engine/package.json","scripts/forge-launcher/scripts/cli.ts"],
  "validationCommands":["npm test --prefix tools/dapr-engine","npm run typecheck --prefix tools/dapr-engine","npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-01","docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-03"],
    "acceptanceCriteria":["Start, status, and stop work through the launcher; restart recovery requires no manual state edits.","Reset requires explicit confirmation; stop and down preserve data."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-03","docs/PRD.md#DAPR-C-04"],
    "references":["plan.md","docs/adr/068-local-deployment-and-access-profiles.md"]
  }
}
```

```forge-task
{
  "id":"P5-05",
  "title":"Harden local access with an operator session",
  "description":"Provide installation-scoped local operator credentials outside task workspaces; exchange a one-time bootstrap capability for an expiring browser session. Authenticate reads, artifacts, event streams, and controls; validate Host/Origin/CSRF; constrain repository paths; support logout and rotation; redact logs. Map the local principal to the contract v1 trusted principal. No GitHub, gh, Copilot, harness, or GitHub App login is required.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":["P5-02"],
  "expectedOutputs":["scripts/forge-launcher/scripts/console/server.ts"],
  "validationCommands":["npm test --prefix scripts/forge-launcher","npm run typecheck --prefix scripts/forge-launcher","npm test --prefix tools/dapr-engine"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-04"],
    "acceptanceCriteria":["Unauthenticated requests and cross-origin mutations are rejected.","A single local operator with no collaborators, GitHub App configuration, or GitHub connectivity can submit, monitor, approve, and recover a scripted-harness run.","Non-loopback startup fails unless a qualified shared profile is configured.","Approvals retain trusted identity and evidence binding."],
    "constraints":[],
    "constraintRefs":["docs/PRD.md#DAPR-C-03","docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-C-01"],
    "references":["plan.md","docs/adr/068-local-deployment-and-access-profiles.md","tools/dapr-engine/contract/v1/controls.ts","docs/contracts/dapr-execution-v1.md"]
  }
}
```

## Phase 8: Shared access

```forge-task
{
  "id":"P8-02-ACCESS",
  "title":"Implement shared GitHub access",
  "description":"Under the P8 gate only: authenticate collaborators via GitHub App user sign-in with state/PKCE where supported, secure server-side sessions, and HTTPS. Authorize by both installation selection and the user's current repository permission using stable GitHub IDs: read/triage view; write/maintain/admin submit/control/approve. Apply authorization to lists, status, logs, artifacts, events, and writes; recheck on sensitive mutations; handle revocation and uninstallation; fail closed. Host administration is separate. Never forward user/session/installation secrets to harnesses.",
  "ownerAgent":"forge-runtime-engineer",
  "dependencies":["P5-05"],
  "expectedOutputs":["scripts/forge-launcher/scripts/console/server.ts"],
  "validationCommands":["npm test --prefix scripts/forge-launcher","npm test --prefix tools/dapr-engine"],
  "contract":{
    "version":2,"kind":"implementation",
    "requirements":[],
    "requirementRefs":["docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-05"],
    "acceptanceCriteria":["Two users with different repository permissions cannot cross-read or cross-control repositories.","Read-only users cannot execute or approve; revoked or uninstalled access is rejected.","An existing browser GitHub session reduces sign-in interaction without bypassing Forge authentication."],
    "constraints":[],
    "constraintRefs":["docs/features/dapr-local-deployment-access.md#DAPR-DEPLOY-C-01"],
    "references":["plan.md","docs/adr/068-local-deployment-and-access-profiles.md"]
  }
}
```

## Exclusions

No public database access, high availability, Kubernetes requirement, clean-host
recovery claim, or execution of untrusted repositories. Broad failure injection
and coordinated restore qualification belong to P6; hosted qualification belongs
to P8.
