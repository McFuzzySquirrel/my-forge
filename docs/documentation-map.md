# Documentation Map

This map explains where MyForge documentation belongs, which document is
authoritative, and when an agent should update it. Documentation is part of the
change that introduces or alters the behavior; it is not a follow-up task.

## How to use this map

Before changing code:

1. Identify the behavior, command, package, or architectural decision being
   changed.
2. Find the corresponding document group below.
3. Read the listed source-of-truth documents before editing.

Before completing the change:

- Update every affected document in the same change.
- Check links, filenames, commands, flags, environment variables, and examples.
- Add a changelog entry for user-visible behavior.
- Add or update an ADR for a significant architectural or behavioral decision.
- If no documentation needs changing, state why in the completion summary.

## Document groups

### Repository guidance

| Document | Authority and purpose | Update when |
|---|---|---|
| [`AGENTS.md`](../AGENTS.md) | Instructions for AI coding agents, repository layout, conventions, and verification commands. | Agent workflow, repository-wide conventions, or validation expectations change. Keep this concise. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Contributor workflow and contribution expectations. | Contributor-facing workflow or contribution policy changes. |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | High-level repository architecture. | Component boundaries, data flow, or system structure changes. |
| [`Project_Architecture_Blueprint.md`](../Project_Architecture_Blueprint.md) | Detailed, code-grounded architecture reference and extension guide. | Package boundaries, runtime topology, persisted contracts, or architecture governance change. |
| [`plan.md`](../plan.md) | Project-level planning, phase status, and qualification evidence. P7 is complete; P8 hosted deployment is not started; post-P7 host-runner HR-04/HR-GATE is pending. | Roadmap, priorities, qualification status, or planned work changes. |

### Product and user-facing documentation

| Document | Authority and purpose | Update when |
|---|---|---|
| [`README.md`](../README.md) | Public overview, runtime prerequisites, quick start, architecture/status summary, main components, and top-level usage. | Installation, Podman requirements, quick start, major features, commands, qualification status, or public terminology change. Keep `**Latest:**` synchronized with [`docs/updates.md`](updates.md). |
| [`docs/forge-launcher.md`](forge-launcher.md) | Detailed launcher command and workflow reference. | Launcher commands, options, environment variables, setup flow, supported harnesses, or credential grants change. |
| [`scripts/forge-launcher/README.md`](../scripts/forge-launcher/README.md) | NPM package and launcher-specific reference. | Package commands, installation, autonomous-build options, or package behavior change. |
| [`docs/forge-console.md`](forge-console.md) | Forge Console capabilities and operation. | Console routes, controls, setup, or user workflows change. |
| [`docs/forge-console-user-guide.md`](forge-console-user-guide.md) | Step-by-step Console walkthrough. | A user-facing Console workflow changes. |
| [`docs/harness-credentials.md`](harness-credentials.md) | Harness credential storage, provider/model matching, worker versus host execution boundaries, threat model, and incident response. | Grant storage, provider auth, worker isolation, host-execution disclosure, or credential-handling guidance changes. |
| [`docs/forge-console-screenshots.md`](forge-console-screenshots.md) | Visual tour and current UI captures. | Significant UI layout or interaction changes make screenshots stale. |
| [`docs/prompt-playbook.md`](prompt-playbook.md) | Interactive launcher prompts and expected answers. | Prompt wording, order, defaults, or onboarding behavior changes. |
| [`docs/running-with-local-models.md`](running-with-local-models.md) | Local-model setup and operation. | Local model providers, configuration, or supported execution paths change. |

### Requirements and authoring

| Document | Authority and purpose | Update when |
|---|---|---|
| [`docs/canonical-features.md`](canonical-features.md) | Canonical requirements layout, ownership, references, validation, and migration rules. | PRD/feature structure, requirement ownership, contract resolution, or migration rules change. |
| [`docs/task-contracts.md`](task-contracts.md) | Task contract format and execution requirements. | Task contract fields, validation, ownership, or generated execution instructions change. |
| [`docs/feature...` templates](../templates/skills/forge-decompose-prd/references/feature-document-template.md) | Template for authored feature documents. | Feature-document structure or required authoring fields change. |
| `templates/skills/*/SKILL.md` | Canonical instructions for each bootstrapped Forge skill. | The skill's inputs, outputs, workflow, commands, constraints, or examples change. |
| `templates/agents/*.md` | Built-in Forge agent personas and responsibilities. | Persona responsibilities, boundaries, collaboration, or supported workflow changes. |

The active requirements contract is `docs/PRD.md` plus `docs/features/*.md`.
Generated manifests are execution snapshots, not an additional source of
requirements. Legacy layouts and migration rules are documented in
[`docs/canonical-features.md`](canonical-features.md) and the relevant ADRs.

### Execution and orchestration

| Document | Authority and purpose | Update when |
|---|---|---|
| [`docs/local-execution.md`](local-execution.md) | Current overview of the local Dapr-backed service-run path, completion evidence, live Console activity, worker execution, and optional host runner. | Service-run responsibilities, runtime topology, execution modes, evidence, observability, or authority boundaries change. |
| [`docs/local-execution-deep-dive.md`](local-execution-deep-dive.md) | Code-grounded lifecycle and implementation guide for current local execution, validation parity, completion replay, evidence, and Console activity. | Submission, orchestration, runner dispatch, workspace handoff, validation, evidence, recovery, persistence, or implementation seams change. |
| [`docs/git-bundle-evidence.md`](git-bundle-evidence.md) | Operator explanation of checkpoint Git bundles: what they contain, how integration and reconstruction use them, when to download them, and how to inspect them safely. | Checkpoint capture, completion evidence, Git-bundle transport, reconstruction, or evidence-download behavior changes. |
| [`docs/long-running-projects.md`](long-running-projects.md) | Long-project operating model: pre-Dapr comparison, limits, recovery, phase-by-phase runs, source-branch merge policy, and P8 boundaries. | Execution limits, phase selection, long-run recovery, host/worker default, or hosted-profile boundaries change. |
| [`docs/workforce-compiler-deep-dive.md`](workforce-compiler-deep-dive.md) | Workforce compiler and kernel handoff details. | Workforce compilation or handoff behavior changes. |
| [`docs/testing-guide.md`](testing-guide.md) | Repository testing and validation guidance. | Supported test commands, package setup, or verification practice changes. |
| `templates/skills/forge-execution-adapter/SKILL.md` | Bootstrapped manifest compiler usage and contract. | Compilation inputs, options, output manifest, or validation behavior change. |
| [`docs/contracts/dapr-execution-v1.md`](contracts/dapr-execution-v1.md) | Versioned application-owned run, control, receipt, artifact, checkpoint, and fencing contract for the Dapr replacement. | Contract fields, state transitions, package ownership, or conformance expectations change. |
| `tools/dapr-engine/contract/v1/`, `tools/dapr-engine/tests/conformance/` | Dapr-independent contract v1 primitives and the runnable §5 conformance fixtures with their in-memory reference model. | Contract cases, rejection codes, state transitions, or digest rules change. |
| `tools/runtime-qualification/` | Dev-only live qualification harness for P6 (failure, backup/restore, and upgrade/rollback suites against isolated rootless Podman runtimes, plus workflow-history capture for replay fixtures). | Scenarios, isolation settings, or qualification evidence requirements change. |
| `tools/dapr-engine/execution/` | Canonical Dapr-independent task/harness execution utilities used by the service worker and host runner. | Utility APIs, adapters, or bootstrap packaging changes. |

### Architecture decisions and research

| Document | Authority and purpose | Update when |
|---|---|---|
| [`docs/adr/`](adr/) | Immutable decision records explaining accepted architectural or behavioral decisions. | Add a new ADR for a significant new decision; do not rewrite history to describe a later change. |
| [`docs/research/`](research/) | Exploratory research, design investigations, and evidence. | Add or revise research when a design investigation materially informs implementation. Mark superseded research clearly. |
| [`docs/AI-RESEARCH-WORKFLOW.md`](AI-RESEARCH-WORKFLOW.md) | Research process and review workflow. | Research methodology or review gates change. |

An ADR should record context, the decision, consequences, alternatives, and
references to the implementation and user documentation. Historical ADRs may
describe retired behavior; active documentation must identify the current
behavior.

### Release and change history

| Document | Authority and purpose | Update when |
|---|---|---|
| [`docs/updates.md`](updates.md) | Versioned changelog and release notes. | Every user-visible change. Add a new version section at the top. |
| [`README.md` latest version](../README.md) | Current release indicator. | Whenever the top version in `docs/updates.md` changes. |
| [`docs/cr-001.md`](cr-001.md) | Code-review record or historical review material. | Only when the associated review record is intentionally extended. Do not use it as the active product specification. |

## Generated artifacts versus source documentation

These files are generated in target repositories by Forge skills and should not
be treated as hand-maintained source documentation in this repository:

- `docs/EXECUTION-MANIFEST.json`
- `docs/forge.log`
- `docs/AUTHORING-EVENTS.jsonl`
- `docs/engine-config.json`
- `docs/artifacts/` execution briefs and local artifact output

Old `docs/WORKFLOW-STATE.json`, `docs/engine-control.json`, `docs/engine.pid`,
`docs/PROGRESS.md`, and `docs/engine-run.log` files are read-only history where
present; they are not current generated state and are not execution authority.

Update the templates, skills, compiler, or engine that produce them instead.
Only update generated examples or fixtures when a test explicitly requires
them.

## Reference-check checklist

For each changed command, option, or behavior, check:

- The implementation and its tests.
- The relevant `SKILL.md` or package README.
- The user-facing guide or top-level README.
- `docs/updates.md`.
- Related ADRs and deep dives.
- Internal links and referenced paths.
- Examples and environment-variable names.
- Generated-artifact descriptions and migration notes.

Do not update every document mechanically. Update the documents whose readers
would otherwise receive incorrect instructions, and preserve historical records
when they accurately describe past behavior.
