import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { must, run } from "./support.ts";

export interface FixtureTask {
  readonly id: string;
  readonly dependencies?: readonly string[];
  /** Extra validation run before the task writes its output file. */
  readonly validation?: readonly string[];
  readonly humanReview?: boolean;
  readonly approvalRequired?: boolean;
}

export const AGENT = "qual-dev";

/** Each implementation task's validation rewrites its seeded qual/<id>.txt, so every attempt produces a real change. */
export function outputCommand(taskId: string): string {
  return `echo "${taskId} $(date +%s%N)" > qual/${taskId}.txt`;
}

function manifest(repoRoot: string, tasks: readonly FixtureTask[]): Record<string, unknown> {
  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    sourceLayout: "features",
    repoRoot,
    harnessRoot: ".github",
    prdPath: "docs/PRD.md",
    visionPath: "docs/PRD.md",
    progressPath: "docs/PROGRESS.md",
    auditPath: "docs/EXECUTION-AUDIT.jsonl",
    validationCommands: [],
    approvalGates: { preflight: false, betweenPhases: false },
    warnings: [],
    phases: [{
      id: "P1",
      title: "Qualification",
      description: "Runtime qualification fixture",
      ownerAgents: [AGENT],
      dependencies: [],
      approvalRequired: false,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: `Qualification task ${task.id}`,
        description: `Fixture task ${task.id}`,
        ...(task.humanReview ? {} : { ownerAgent: AGENT }),
        contract: task.humanReview
          ? { version: 1, kind: "human-review", requirements: ["Review the fixture"], acceptanceCriteria: ["Approved"], constraints: ["Change only qual/"], references: ["docs/features/qualification.md"] }
          : { version: 1, kind: "implementation", requirements: [`Write qual/${task.id}.txt`], acceptanceCriteria: ["Validation passes"], constraints: ["Change only qual/"], references: ["docs/features/qualification.md"] },
        dependencies: [...(task.dependencies ?? [])],
        expectedOutputs: task.humanReview ? [] : [`qual/${task.id}.txt`],
        validationCommands: task.humanReview ? [] : [...(task.validation ?? []), outputCommand(task.id)],
        approvalRequired: task.approvalRequired ?? false,
        sourceLines: [],
      })),
    }],
  };
}

/** Creates a committed forge fixture repository with a hand-written manifest. */
export function createFixtureRepo(root: string, name: string, tasks: readonly FixtureTask[]): string {
  const repoRoot = path.join(root, "repos", name);
  mkdirSync(path.join(repoRoot, "docs", "features"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".github", "agents"), { recursive: true });
  writeFileSync(path.join(repoRoot, "docs", "PRD.md"), "# Qualification fixture\n\nRuntime qualification repository.\n");
  writeFileSync(path.join(repoRoot, "docs", "features", "qualification.md"), "# Qualification\n\nFixture feature.\n");
  writeFileSync(path.join(repoRoot, ".github", "agents", `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: "Qualification fixture agent."\n---\n\nYou complete qualification fixture tasks.\n`);
  if (!existsSync(path.join(repoRoot, ".git"))) {
    must("git", ["init", "--quiet", "--initial-branch=main"], repoRoot);
  }
  must("git", ["config", "user.email", "qualification@myforge.invalid"], repoRoot);
  must("git", ["config", "user.name", "MyForge Qualification"], repoRoot);
  writeManifest(repoRoot, tasks);
  return repoRoot;
}

/** Rewrites the manifest and commits it, so later runs on the same repository can use new tasks. */
export function writeManifest(repoRoot: string, tasks: readonly FixtureTask[]): void {
  mkdirSync(path.join(repoRoot, "qual"), { recursive: true });
  for (const task of tasks) {
    const output = path.join(repoRoot, "qual", `${task.id}.txt`);
    if (!task.humanReview && !existsSync(output)) writeFileSync(output, `${task.id} pending\n`);
  }
  writeFileSync(path.join(repoRoot, "docs", "EXECUTION-MANIFEST.json"), `${JSON.stringify(manifest(repoRoot, tasks), null, 2)}\n`);
  must("git", ["add", "-A"], repoRoot);
  if (run("git", ["diff", "--cached", "--quiet"], repoRoot).code !== 0) {
    must("git", ["commit", "--quiet", "-m", "qualification fixture"], repoRoot);
  }
}

/** Subjects of the run's integration commits on the forge branch, oldest first. */
export function runCommits(repoRoot: string, runId: string, branch = "forge/main"): string[] {
  const result = run("git", ["log", "--reverse", "--format=%s%x1f%b%x1e", branch], repoRoot);
  if (result.code !== 0) return [];
  return result.stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => entry.split("\x1f"))
    .filter(([, body]) => (body ?? "").includes(`MyForge run ${runId}`))
    .map(([subject]) => subject!);
}

/** Per-task integration commit counts for a run; exactly-once integration means every count is 1. */
export function commitCounts(repoRoot: string, runId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const subject of runCommits(repoRoot, runId)) {
    const taskId = subject.split(":")[0]!;
    counts[taskId] = (counts[taskId] ?? 0) + 1;
  }
  return counts;
}
