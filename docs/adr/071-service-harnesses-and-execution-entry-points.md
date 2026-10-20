# ADR-071: Service Harnesses and Execution Entry Points

**Status:** Accepted  
**Date:** 2026-10-22

## Context

P5-03 gave the local runtime a run API ([ADR-069](069-service-run-submission-and-repository-binding.md)).
However, the worker provided only the deterministic `stub` harness. So
`engine-run`, `resume`, auto-build, and Console builds still used the legacy
engine and its file and PID controls. Three questions blocked the migration:

1. How real harness CLIs and their credentials reach the worker without being
   baked into images, leaked into task workspaces, or shared across harnesses.
2. How the launcher picks the service instead of the legacy engine. ADR-068
   requires selecting *local versus hosted deployment*, not legacy versus Dapr
   scheduling.
3. How `human-review` tasks run in the service. The execution host refused
   them, because a human review must never be sent to a model. The live P5
   gate run failed on that refusal.

## Decision

### Harness provisioning

- The worker image (`localhost/myforge-worker:2`) installs pinned harness CLIs:
  `@github/copilot@1.0.100`, `@anthropic-ai/claude-code@2.1.304`, and
  `opencode-ai@1.19.3`. Bump the image tag whenever a pin changes so existing
  installations rebuild.
- Credentials are never baked into the image. The operator grants them with
  `forge-launcher runtime harness grant <harness> <VARIABLE> [--from-env]`.
  The value is read from stdin or the environment, never from argv. Grants are
  stored in `harness-grants/grants.json` under the runtime data directory,
  with mode `0600` in a `0700` directory, and mounted read-only into the
  worker. `runtime harness list` shows variable names only; `revoke` removes
  grants.
- Each harness accepts only its own allowlisted variables:
  - copilot: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
  - claude: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`
  - opencode: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
    `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`

  Grants outside a harness's allowlist are ignored, so a grant for one
  harness never reaches another.
- The worker re-reads the grant file for every attempt, so grants and
  revocations apply to the next attempt without a restart. A malformed file
  fails closed.
- A submission for a harness whose CLI is missing, or that has no grant, is
  rejected with HTTP 422 `harness-unavailable` and a remediation detail. It is
  never accepted and then failed. `stub` needs no grant.
- Claude Code refuses `bypassPermissions` when run as root. The worker passes
  the non-secret `IS_SANDBOX=1` setting, because the container and its
  per-attempt workspace are the sandbox.

### Deployment selection

- `FORGE_DEPLOYMENT` selects the deployment.
  - Unset or `local`: use the local execution service.
  - `hosted`: fail clearly until P8 qualifies hosted availability.
  - Any other value is an error.
- A repository registered with `runtime repo add` uses the service. That
  covers `engine-run`, `resume`, Console Overview builds and controls, and
  feature-increment runs. `engine-run` compiles a missing manifest, then
  attaches to or resumes the repository's active run, or submits a new one. It
  follows the sequenced events and fast-forwards the checked-out branch to
  `forge/<branch>` when the run completes. `--stop`/`--pause` send service
  controls. Engine flags without a service meaning are reported as ignored.
- Unregistered repositories keep the legacy engine until P7 switches the
  default and retires it. Registering a repository is the migration step.
- The Console routes pause, stop, replay, and human-review approval to the
  newest service run of a registered repository. The Overview shows which
  deployment the open repository uses.

### Human review in the service

- An attempt for a task whose contract kind is `human-review` never prepares
  a workspace or invokes a harness. It publishes a review evidence artifact
  binding the run, manifest digest, task contract, target ref, and current
  target head. The operation receipt moves to `effect-published` with that
  digest and then to `accepted`. The attempt then waits for approval.
- The approval context exposes that evidence digest. An authorized
  `approve-task` must name it, exactly like effect approvals.
- Resuming an approved review completes the task without a repository effect.
  The completion evidence has no output files, uses the review digest as the
  handoff digest, and records `human review approved by <operator>` as the
  harness-gate evidence.

## Consequences

- Real harness runs go through the durable service, with restart rebinding,
  sequenced events, and authenticated controls. Most legacy PID and file
  controls are no longer needed for registered repositories.
- Operators manage harness credentials explicitly per installation. Ambient
  host logins (`gh auth`, `~/.claude`) are not visible to the worker.
- Pinned CLI upgrades are release work: change the pins and bump the image tag.
- The legacy engine stays for unregistered repositories until P7. Two paths
  exist during the transition, and both are tested.
- Human-review evidence binds to the target head at the time of the wait. A
  later review approval cannot be replayed against different evidence.

## Alternatives considered

- **Mount host harness logins** (`~/.config/gh`, `~/.claude`, and similar). Rejected.
  This would expose every ambient credential to the worker and couple it to
  the host OS layout. It would also violate DAPR-DEPLOY-03.
- **Pass credentials in the run submission.** Rejected. Secrets would cross
  the API, enter idempotency snapshots and logs, and persist with the run.
- **Select the service by a legacy/Dapr scheduler flag.** Rejected by ADR-068.
  Repository registration and `FORGE_DEPLOYMENT` describe deployment, and P7
  removes the legacy default.
- **Send human-review tasks to a harness with a "do nothing" prompt.**
  Rejected. A review attests to delivered work and must never be delegated to
  a model.

## References

- Implementation:
  - `tools/dapr-engine/service/harnesses.ts`
  - `tools/dapr-engine/deploy/worker.Containerfile`
  - `tools/dapr-engine/orchestration/execution-host.ts`
  - `scripts/forge-launcher/scripts/runtime-harnesses.ts`
  - `scripts/forge-launcher/scripts/service-run.ts`
  - `scripts/forge-launcher/scripts/console/service-runs.ts`
- Documentation:
  - [Forge Launcher service runs](../forge-launcher.md#service-runs)
  - [Forge Console service runs](../forge-console.md#service-runs)
  - [Local deployment feature](../features/dapr-local-deployment-access.md)
- Related ADRs: [ADR-068](068-local-deployment-and-access-profiles.md),
  [ADR-069](069-service-run-submission-and-repository-binding.md),
  [ADR-070](070-local-operator-session-and-sidecar-token.md).
