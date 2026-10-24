---
name: forge-auto-build
description: "Terminal/headless build pipeline from validated docs/PRD.md and docs/features/*.md through team generation, optional model assignment and one execution path. Use when approved canonical features should become a built, validated project after one pre-flight gate. Autonomous execution uses the registered Dapr service."
---

# Skill: Full Auto Build (End-to-End Pipeline)

You are running the **build pipeline** on behalf of the user in one continuous, autonomous flow. Your job is to chain the downstream skills and agents in order, validate outputs at each stage, commit after each phase, and produce a finished project -all from a single invocation.

> **Where this skill fits.** `forge-auto-build` is the **terminal/headless fast-path**:
> it is invoked by `forge-launcher` (headless runs) or directly via
> `opencode run --auto` / `copilot -p --yolo`. It is **not** the in-harness
> interactive entry point. If you are already inside a chat harness, drive the
> build with `@project-orchestrator` (`forge-orchestrate-build`, interactive,
> per-phase approval). Autonomous execution uses `forge-launcher run`
> against a repository registered with the local Dapr service. The service
> expects the agent team and execution manifest to already exist
> (generate it via `forge-launcher resume` or `/forge-build-agent-team`).
> This skill exists so a terminal/CI flow can chain team generation → build
> without a chat session.

The underlying skills (`forge-build-agent-team`, `forge-assign-models`, `forge-orchestrate-build`) each own their own work. You are the conductor: you invoke them in sequence, verify each handoff, commit progress, and keep the user informed without interrupting them.

**Reviewed features are a required prerequisite.** This skill does not author requirements. It consumes only `docs/PRD.md` with `docs/features/*.md`. Run `validate-prd` before team generation. Missing canonical files require `forge-build-prd` or conversion with `forge-decompose-prd`; historical source documents are not executable.

---

## What This Skill Does vs. Existing Skills

| Skill | Scope | Pauses |
|---|---|---|
| `forge-auto-build-prd` | idea to reviewed canonical vision and features (always interactive) | Review gate inside authoring flow |
| `forge-build-prd` | idea/seed docs to vision and features directly (always interactive) | Review gate before save |
| `@project-orchestrator` | In-harness interactive build execution only (no PRD, no team) | Optional pause between each phase |
| `forge-launcher run` | Autonomous execution through the registered Dapr service | Service run controls |
| **`forge-auto-build`** | **Terminal/headless** fast-path: existing PRD → agent team → (optional models) → choose interactive or Dapr service execution → committed result | **One** pre-flight gate, then fully autonomous |

Use this skill when you want the build pipeline to run hands-free after a single approval, from a PRD that has already been reviewed and confirmed.

---

## Operating Principles

- **The PRD is a quality gate, not an input to be manufactured here.** Before any work, verify a PRD representation exists. If it does not, stop and direct the user to `forge-auto-build-prd` or `forge-build-prd`. Never fall back to interviewing the user for a one-line idea.
- **One gate, then fully autonomous.** The pre-flight confirmation (Step 0) is the only mandatory pause. Once the user types `GO`, every stage runs to completion without further interruption.
- **Never skip a stage silently.** If a stage fails or produces an unexpected result, stop immediately, report what happened, and ask the user how to proceed. Do not guess or silently skip.
- **Invoke, do not re-implement.** The work -designing the team, scaffolding, executing phases -belongs to the underlying skills. You sequence them. Never duplicate their logic.
- **Commit after every phase.** After each build phase completes and its validation passes, commit the changes with a descriptive message and update `docs/PROGRESS.md`.
- **Validate before continuing.** After each stage, verify the expected output exists and is well-formed before moving to the next stage.
- **Be explicit about progress.** At every message, state which stage you are in (e.g., "Stage 1 of 3: forge-build-agent-team") and what comes next.
- **Resumability.** If re-invoked mid-flow, inspect the repo state and resume from the earliest incomplete stage rather than starting over.

---

## Process

### Step 0: Pre-Flight Confirmation (Mandatory -the only pause)

When the user invokes this skill, perform the following before touching any files:

1. **Verify canonical sources.** Require `docs/PRD.md` and at least one `docs/features/*.md`, then run `validate-prd`. Stop on errors and direct the user to author or convert requirements.
2. **Select features.** Use the canonical feature graph. Explicit feature selections must belong to it. Do not offer a legacy document or alternate layout as a build source.
3. **Echo the selected PRD.** Restate the selected PRD (or vision + features) path in one or two sentences so the user can see what this run will use.
   - Do not add any extra confirmation gate here; continue to the normal pre-flight summary and `GO` checkpoint.
4. **Check repo state** and flag anything that changes the flow:
   - Do `.md` agent files already exist in `HARNESS_AGENTS_DIR` (beyond the forge templates)? If yes, note that Stage 1 (team generation) will run in **Feature Increment Mode**.
   - Does `docs/PRD.md` also exist? If yes, note it is a legacy source filename and Stage 1 still reads `docs/PRD.md` with features.
   - Always use feature-based team generation and execution.
5. **Present the planned stages** as a numbered list:
   - Stage 1: `forge-build-agent-team` → produce agents and immutable `docs/SKILL-CANDIDATES.json`
   - Stage 1b: `forge-build-project-skills` → create/reuse/extend planned project skills independently
   - Stage 2 (optional): `forge-assign-models` → recommend or apply per-agent models *(opt-in -include if user passed `--assign-models`)*
   - Stage 3: Build execution *(choose one path)*:
     - Default: `forge-orchestrate-build` - execute all phases continuously, committing after each phase
     - With `--dapr-service`: compile `docs/EXECUTION-MANIFEST.json` and execute through the registered Dapr service
6. **State the commit strategy** explicitly:
   - After Stage 1: `chore: bootstrap MyForge agent templates and skill candidates`
   - After Stage 1b: `feat: generate project skills`
   - After each build phase N: `feat: complete Phase N -<phase name>`
   - After all phases: `chore: auto-build complete -all phases delivered`
7. **Present the pre-flight checklist** (see below).
8. **Prompt**: *"Review the plan above. Type `GO` to start the auto-build on the default prompt-driven path, `GO --assign-models` to also run model assignment, `GO --dapr-service` to use the registered Dapr service instead of `forge-orchestrate-build`, or `stop` to exit."*

> **Headless invocation.** When this skill is driven from a non-interactive
> terminal (`opencode run` / `copilot -p --yolo`, e.g. via `forge-launcher
> --headless`), the confirmation gate is satisfied by the invocation itself:
> a `GO` (optionally with `--assign-models` / `--dapr-service`) embedded in
> the invocation message counts as the user's approval. Present the pre-flight
> summary and checklist as the run's audit trail, then proceed without pausing
> for a separate reply.

**PRD-requirement behavior examples:**

- Canonical vision and features exist: validate and use the feature graph.
- Only legacy source documents exist: stop and direct to `forge-decompose-prd`.
- No requirements exist: stop and direct to `forge-auto-build-prd` or `forge-build-prd`.

**Do not proceed until the user types `GO` (or a clear equivalent such as `start`, `run it`, `proceed`).**

**Pre-flight checklist (emit verbatim):**

```
Pre-flight checklist -verify before typing GO:

Input
- [ ] Canonical requirements exist and are validated
  (docs/PRD.md + docs/features/*.md, including one-feature solutions)
- [ ] The PRD has been reviewed and you are ready to build from it
- [ ] The target project directory is open and git-initialised
- [ ] MyForge templates are bootstrapped (`HARNESS_AGENTS_DIR` and `HARNESS_SKILLS_DIR` exist)

Scope
- [ ] You understand that this skill will run autonomously until all phases are complete
- [ ] You are comfortable with the commit strategy listed above
- [ ] There are no uncommitted changes that could be lost (run `git status` if unsure)

Expectations
- [ ] You have reviewed the note on skipped stages (existing agents, decomposed layout)
- [ ] You know you can interrupt at any time with Ctrl+C or by closing the session -PROGRESS.md
      will record the last completed task so you can resume manually
```

---

### Stage 1: Run `forge-build-agent-team`

Invoke `forge-build-agent-team` against the validated PRD and feature graph. Use initial team generation or feature-increment mode, never a standalone source document.

When it finishes:
- Verify `.md` agent files exist under `HARNESS_AGENTS_DIR`.
- Verify the forge template agents (`project-orchestrator`, `forge-team-builder`) are still present and untouched.
- Commit the generated files:
  ```
  git add {HARNESS_AGENTS_DIR}/ {HARNESS_SKILLS_DIR}/ docs/
  git commit -m "chore: bootstrap MyForge agent and skill templates"
  ```
- Report: "Stage 1 complete -agent team and skill handoff committed. Moving to Stage 1b."

---

### Stage 1b: Run `forge-build-project-skills`

Invoke the independent project-skill stage against
`docs/SKILL-CANDIDATES.json`. It may reuse unchanged packages, but it must
create or extend only non-omit candidates and must pass the structural and
per-axis quality gate for the affected files. An empty or all-`omit` handoff is
an explicit successful no-skills stage.

When it finishes:
- Verify the candidate handoff is unchanged and project skills are present only
  for non-omit candidates.
- Commit:
  ```
  git add {HARNESS_SKILLS_DIR}/ docs/authoring-state.json
  git commit -m "feat: generate project skills"
  ```
- Report: "Stage 1b complete -project skills reviewed and committed. Moving to Stage 2."

---

### Stage 2 (Optional): Run `forge-assign-models`

Run this stage only if the user included `--assign-models` in their `GO` command.

Invoke the `forge-assign-models` skill in **Recommend** mode first (produce `docs/MODEL-PLAN.md` without modifying agent files). Then immediately invoke it again in **Apply** mode to write the models into agent YAML frontmatter.

When it finishes:
- Verify `docs/MODEL-PLAN.md` exists and each agent file has a `model:` field.
- Commit:
  ```
  git add {HARNESS_AGENTS_DIR}/ docs/MODEL-PLAN.md
  git commit -m "chore: apply per-agent model assignments"
  ```
- Report: "Stage 2 complete -per-agent models applied. Moving to Stage 3."

If `--assign-models` was not requested, skip this stage and note: "Stage 2 skipped (no --assign-models flag). You can run forge-assign-models manually at any time. Moving to Stage 3."

---

### Stage 3: Execute the Build - Choose One Path

By default, use the prompt-driven path below. If the user included
`--dapr-service` in the `GO` command, skip Path A and run Path B instead. Do
**not** run both paths in the same auto-build invocation.

#### Path A (default): Run `forge-orchestrate-build` - All Phases

Invoke the `forge-orchestrate-build` skill in **continuous mode** (execute all phases without pausing between them).

For each phase, the skill will:
1. Execute each task by calling the appropriate specialist agent.
2. Verify deliverables exist and are well-formed.
3. Run build/lint/test validation for the phase's changes.
4. Update `docs/PROGRESS.md`.

After each phase completes validation, you **must** perform the following before the skill proceeds to the next phase:

**Per-phase commit sequence:**
```
git add .
git commit -m "feat: complete Phase N -<phase name from PRD>"
```

Verify the commit succeeded before the skill moves to the next phase. If the commit fails, stop and report the error.

**Build validation gate (per phase):**
Before committing and before proceeding to the next phase, verify:
- [ ] All files the phase was supposed to produce exist at the correct paths
- [ ] Build/lint/test commands pass for the phase's changes (run the project's own build and test commands, or those defined in the PRD)
- [ ] `docs/PROGRESS.md` reflects the completed phase
- [ ] No phase acceptance criteria from the PRD are unmet

If any validation check fails, do **not** commit and do **not** proceed. Stop and report: which check failed, the exact error output, and which agent or task is responsible. Ask the user how to proceed.

---

#### Path B (`--dapr-service`): Run through the Dapr service

Run this path only if the user included `--dapr-service` in the `GO` command.
The Dapr service is the only supported autonomous execution backend; legacy
workflow histories and `docs/WORKFLOW-STATE.json` are not imported.

**Step 3a: Compile the execution manifest**

```bash
cd .agents/skills/forge-execution-adapter
npm install
npm run forge-execution-adapter -- compile
```

Verify that `docs/EXECUTION-MANIFEST.json` was written and contains at least
one phase with tasks. Surface adapter warnings before continuing.

**Step 3b: Verify service registration and run**

The repository must be registered with the local runtime. If it is not already
registered, add it and restart the runtime:

```bash
forge-launcher runtime repo add "$PWD"
forge-launcher runtime restart
```

Then start or attach to the service run:

```bash
forge-launcher run --repo "$PWD" --harness "${FORGE_ENGINE_HARNESS:-opencode}" --yes
```

The service owns run history and repository integration. Harness CLI execution
requires a credential grant (`forge-launcher runtime harness grant <harness>
<VARIABLE>`); ungranted harnesses fail closed. The command follows service
events and returns when the run completes, fails, or pauses.

**Step 3c: Verify completion and recover**

Use `forge-launcher service runs --repo "$PWD"` and
`forge-launcher service status <run-id>` to inspect durable run state. A
completed service run has status `complete`; report task failures and blockers
from the service snapshot. After fixing a failed task, replay it with
`forge-launcher service control <run-id> replay-task --task <task-id>`, then
resume with `forge-launcher run --repo "$PWD" --yes`.

When it finishes, report: "Stage 3 complete - Dapr service run finished. All
tasks complete."

If `--dapr-service` was not requested, use `forge-orchestrate-build` for
Stage 3; never invoke the retired workflow-engine scheduler.

---

### Final Stage: Completion Summary

After the selected Stage 3 build path is complete:

1. Commit any remaining uncommitted work. **Never commit engine dependencies**: skip the `node_modules/` directories under the skill packages and the engine log:
   ```
   git add . ':(exclude)**/node_modules/**' ':(exclude)docs/run.log'
   git commit -m "chore: auto-build complete -all phases delivered"
   ```
2. Produce a **Final Summary** report in the terminal:

```
=== forge-auto-build: Complete ===

Stages completed:
  ✅ Stage 1: Agent team generated (N agents, M skill candidates)
  ✅ Stage 1b: Project skills [generated | not required]
  [✅ or ⏭️] Stage 2: Per-agent models [applied | skipped]
  ✅ Stage 3: Build execution completed via [forge-orchestrate-build | Dapr service]

Commits made: <N>
Files produced: <list key output files>
Docs updated: docs/PROGRESS.md, docs/PRD.md, docs/agent-responsibility-matrix.md, docs/EXECUTION-MANIFEST.json

Next steps:
  - Review docs/PROGRESS.md for the full task history
  - Run your project's tests to verify the final state: <test command from PRD>
  - Add a new feature: @workspace /forge-build-feature-prd I want to add [feature]...
  - Audit generated skills (automated): cd .agents/skills/skill-review && npm install && npm run skill-review -- --provider stdout --min-score 1.5
  - Audit generated skills (manual): @workspace /forge-optimize-skills Audit all skills...
   - Run the service path later if desired: `forge-launcher run --repo . --yes` (repository registration required)
```

---

## Resuming After Interruption

If this skill is invoked in a repo that has an incomplete auto-build (detected by `docs/PROGRESS.md` having uncompleted tasks):

1. Read `docs/PROGRESS.md` to determine the last completed task.
2. Determine which stage was interrupted:
   - If interrupted mid-Stage 1: re-invoke `forge-build-agent-team`.
   - If interrupted mid-Stage 2: re-run the affected stage from the beginning.
   - If interrupted mid-Stage 3 on the prompt-driven path: invoke `forge-orchestrate-build` with `resume from last checkpoint`.
   - If interrupted mid-Stage 3 on the Dapr service path: run `forge-launcher run --repo . --yes`; it resumes or attaches to the active service run.
3. Report to the user: "Resuming auto-build from Stage N, last completed: [task description]."
4. Do not re-run stages whose outputs are already committed and verified.

---

## Error Handling

| Situation | Response |
|---|---|
| No PRD representation exists at pre-flight | Stop before Stage 1; direct the user to `forge-auto-build-prd` or `forge-build-prd` |
| Stage 1 produces no agent files | Stop and report; do not proceed to build |
| Stage 2 model assignment fails | Log the failure, skip Stage 2, continue to Stage 3 -report at the end |
| Stage 3 prompt-driven phase fails validation | Stop after the failing phase; report error, blocked phase, and responsible agent |
| Stage 3 prompt-driven commit fails | Stop immediately; report the git error |
| Stage 3 Dapr manifest compile fails | Surface adapter warnings; do not start the service run until resolved |
| Stage 3 Dapr task fails | Surface the failing task ID and error; use the service replay control |
| Any unexpected file conflict | Stop and ask the user whether to overwrite, merge, or abort |

---

## Gotchas

- **Do not skip the pre-flight gate.** Even if the user says "just run everything," you must present the pre-flight checklist and require a `GO` before starting. This is the only safeguard in a fully autonomous run.
- **Never generate a PRD or interview for an idea.** This skill requires an existing PRD. If none exists, stop and point the user to `forge-auto-build-prd` / `forge-build-prd`. Manufacturing requirements inside the build pipeline is forbidden.
- **Never auto-apply models without `--assign-models`.** Stage 2 is opt-in. Writing to agent YAML frontmatter without explicit intent is a violation of `forge-assign-models`'s safety constraint.
- **Commit after every phase, not at the end.** Batching commits defeats the purpose of phase-level checkpoints and makes debugging harder.
- **Choose exactly one build path per run.** `--dapr-service` switches Stage 3 to the Dapr service path; without it, use `forge-orchestrate-build`. Do not run one path and then replay the whole build through the other in the same invocation.
- **Do not suppress validation errors.** If a phase fails its build/test validation, stopping is the correct behavior -not retrying silently or moving on with a warning.
- **Respect agent boundaries.** When driving Stage 3, do not instruct agents to do work outside their documented expertise. Delegate cross-cutting tasks to the correct owner agents.
- **One invocation, one run.** This skill does not support running two independent projects simultaneously. If the workspace has multiple PRDs or project roots, ask the user to clarify which one to build before starting.
