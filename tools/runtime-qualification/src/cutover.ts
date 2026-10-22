import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixtureRepo } from "./fixture.ts";
import { connect, runState, submit, taskStatus, waitForApi, waitForTerminal } from "./service.ts";
import {
  assert,
  containerState,
  launcher,
  must,
  REPO_ROOT,
  requireLauncher,
  run,
  useLauncherFrom,
  type Isolation,
  type Report,
} from "./support.ts";
import { previousRelease } from "./upgrade.ts";

interface LegacyTaskSnapshot {
  readonly status?: string;
  readonly outputFiles?: readonly string[];
}

interface LegacyWorkflowSnapshot {
  readonly runId?: string;
  readonly status?: string;
  readonly tasks?: Readonly<Record<string, LegacyTaskSnapshot>>;
}

const LEGACY_PATHS = [
  "docs/WORKFLOW-STATE.json",
  "docs/EXECUTION-AUDIT.jsonl",
  "docs/PROGRESS.md",
  "docs/engine-run.log",
  "docs/engine-control.json",
  "docs/task-executions",
  "docs/artifacts",
] as const;

function readLegacyState(repoRoot: string): LegacyWorkflowSnapshot {
  return JSON.parse(readFileSync(path.join(repoRoot, "docs", "WORKFLOW-STATE.json"), "utf8")) as LegacyWorkflowSnapshot;
}

function archiveLegacyFiles(repoRoot: string, archive: string): string[] {
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const relative of LEGACY_PATHS) {
    const source = path.join(repoRoot, relative);
    if (!existsSync(source)) continue;
    const destination = path.join(archive, relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(source, destination, { recursive: true, errorOnExist: true });
    copied.push(relative);
  }
  return copied;
}

function commitFixtureChanges(repoRoot: string, message: string): void {
  must("git", ["add", "-A"], repoRoot);
  if (run("git", ["diff", "--cached", "--quiet"], repoRoot).code !== 0) {
    must("git", ["commit", "--quiet", "-m", message], repoRoot);
  }
}

async function resetIsolatedRuntime(isolation: Isolation): Promise<void> {
  if (existsSync(path.join(isolation.runtimeDir, "runtime.env"))) {
    const reset = await launcher(["runtime", "reset", "--confirm"]);
    assert(reset.code === 0, `isolated runtime reset failed: ${reset.stderr || reset.stdout}`);
    return;
  }
  const prefix = `${isolation.project}_`;
  const containers = must("podman", ["ps", "-a", "--format", "{{.Names}}"]).split("\n").filter((name) => name.startsWith(prefix));
  const volumes = must("podman", ["volume", "ls", "--format", "{{.Name}}"]).split("\n").filter((name) => name.startsWith(prefix));
  assert(containers.length === 0 && volumes.length === 0, `isolated resources exist without runtime credentials: ${JSON.stringify({ containers, volumes })}`);
}

function installLegacyDependencies(previousRoot: string, engineRoot: string): void {
  if (!existsSync(path.join(engineRoot, "node_modules", "tsx"))) {
    const installed = run("npm", ["install", "--no-audit", "--no-fund", "--silent"], engineRoot);
    assert(installed.code === 0, `previous-release workflow-engine dependencies failed to install: ${installed.stderr || installed.stdout}`);
  }
  const adapterRoot = path.join(previousRoot, "templates", "skills", "forge-execution-adapter");
  if (!existsSync(path.join(adapterRoot, "node_modules", "gray-matter"))) {
    const installed = run("npm", ["install", "--no-audit", "--no-fund", "--silent"], adapterRoot);
    assert(installed.code === 0, `previous-release execution-adapter dependencies failed to install: ${installed.stderr || installed.stdout}`);
  }
  const executionRoot = path.join(previousRoot, "tools", "dapr-engine");
  if (!existsSync(path.join(executionRoot, "node_modules", "cross-spawn"))) {
    const installed = run("npm", ["install", "--no-audit", "--no-fund", "--silent"], executionRoot);
    assert(installed.code === 0, `previous-release Dapr execution dependencies failed to install: ${installed.stderr || installed.stdout}`);
  }
}

function runLegacyEngine(engineRoot: string, repoRoot: string): { code: number; stdout: string; stderr: string } {
  return run("npm", [
    "run", "workflow-engine", "--", "run", "--repo", repoRoot, "--harness", "stub", "--yes",
  ], engineRoot);
}

function startLegacyEngine(engineRoot: string, repoRoot: string): {
  readonly started: Promise<void>;
  readonly completed: Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
} {
  const child = spawn("npm", [
    "run", "workflow-engine", "--", "run", "--repo", repoRoot, "--harness", "stub", "--yes",
  ], {
    cwd: engineRoot,
    env: { ...process.env, STUB_DELAY_MS: "1500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let startSettled = false;
  let resolveStart!: () => void;
  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const startTimeout = setTimeout(() => {
    if (startSettled) return;
    startSettled = true;
    rejectStart(new Error("previous-release run did not start its first task within 30 seconds"));
    child.kill("SIGTERM");
  }, 30_000);
  const completed = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(startTimeout);
      if (!startSettled) {
        startSettled = true;
        rejectStart(error);
      }
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!startSettled && stdout.includes("[engine] Starting task P1:")) {
        startSettled = true;
        clearTimeout(startTimeout);
        resolveStart();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      clearTimeout(startTimeout);
      if (!startSettled) {
        startSettled = true;
        rejectStart(new Error(`previous-release run exited before starting P1 (${code ?? 1}): ${stderr || stdout}`));
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return { started, completed };
}

function validateCompletedLegacyCheckpoint(repoRoot: string, state: LegacyWorkflowSnapshot): void {
  assert(state.status === "complete", `legacy run status was ${state.status ?? "missing"}`);
  const tasks = Object.values(state.tasks ?? {});
  assert(tasks.length > 0, "legacy state has no task checkpoint records");
  for (const task of tasks) {
    assert(task.status === "complete", `legacy task status was ${task.status ?? "missing"}`);
    for (const output of task.outputFiles ?? []) {
      assert(existsSync(path.resolve(repoRoot, output)), `legacy checkpoint output is missing: ${output}`);
    }
  }
}

/**
 * P7 migration and rollback rehearsal against a previous-release scheduler and
 * a separate local Dapr installation. The operator runtime is never selected.
 */
export async function runCutoverSuite(report: Report, isolation: Isolation): Promise<void> {
  const current = REPO_ROOT;
  const previous = previousRelease(isolation.root);
  const engineRoot = path.join(previous, "templates", "skills", "forge-workflow-engine");
  const nonce = randomBytes(4).toString("hex");
  const legacyRepo = createFixtureRepo(isolation.root, `cutover-complete-${nonce}`, [{ id: "L1" }]);
  const partialRepo = createFixtureRepo(isolation.root, `cutover-partial-${nonce}`, [
    { id: "P1" },
    { id: "P2", dependencies: ["P1"] },
  ]);
  const legacyStatePath = path.join(legacyRepo, "docs", "WORKFLOW-STATE.json");
  const archive = path.join(isolation.root, "backups", `pre-cutover-${nonce}`);
  const completeArchive = path.join(archive, "complete");
  const partialArchive = path.join(archive, "partial");
  const completeBundle = path.join(archive, "complete-repository.bundle");
  const partialBundle = path.join(archive, "partial-repository.bundle");
  const serviceBackup = path.join(isolation.root, "backups", `post-cutover-${nonce}`);

  let legacyRunId = "";
  let legacyStateText = "";
  let serviceRunId = "";
  let partialLegacyRunId = "";
  let preCutoverHead = "";
  let postCutoverHead = "";

  try {
    const migrated = await report.scenario(
      "P7-01",
      "Archive a completed legacy checkpoint before starting an independent Dapr run",
      async (details) => {
        useLauncherFrom(current);
        await resetIsolatedRuntime(isolation);

        installLegacyDependencies(previous, engineRoot);
        const oldRun = runLegacyEngine(engineRoot, legacyRepo);
        assert(oldRun.code === 0, `previous-release legacy run failed: ${oldRun.stderr || oldRun.stdout}`);
        const legacyState = readLegacyState(legacyRepo);
        validateCompletedLegacyCheckpoint(legacyRepo, legacyState);
        assert(typeof legacyState.runId === "string" && legacyState.runId.length > 0, "legacy run ID is missing");
        legacyRunId = legacyState.runId;
        legacyStateText = readFileSync(legacyStatePath, "utf8");
        assert(!existsSync(path.join(legacyRepo, "docs", "engine.pid")), "legacy engine PID remained after the completed foreground run");

        const partialProcess = startLegacyEngine(engineRoot, partialRepo);
        await partialProcess.started;
        writeFileSync(path.join(partialRepo, "docs", "engine-control.json"), `${JSON.stringify({
          request: "stop",
          requestedAt: new Date().toISOString(),
        })}\n`);
        const partialResult = await partialProcess.completed;
        assert(partialResult.code === 0, `previous-release drain failed: ${partialResult.stderr || partialResult.stdout}`);
        const partialState = readLegacyState(partialRepo);
        assert(partialState.status === "paused", `drained legacy run status was ${partialState.status ?? "missing"}`);
        assert(partialState.tasks?.P1?.status === "complete", "drained legacy run did not finish its active task");
        assert(partialState.tasks?.P2?.status === "pending", "drained legacy run started another task after stop");
        assert(!existsSync(path.join(partialRepo, "docs", "engine.pid")), "legacy engine PID remained after the drained run exited");
        assert(typeof partialState.runId === "string" && partialState.runId.length > 0, "partial legacy run ID is missing");
        partialLegacyRunId = partialState.runId;
        details.drainedLegacyRunId = partialLegacyRunId;
        details.drainedRun = "P1 completed, P2 remained pending, engine exited and removed its PID";

        commitFixtureChanges(legacyRepo, "archive completed legacy checkpoint");
        commitFixtureChanges(partialRepo, "archive partial legacy checkpoint");
        preCutoverHead = must("git", ["rev-parse", "HEAD"], legacyRepo);
        const copied = archiveLegacyFiles(legacyRepo, completeArchive);
        const partialCopied = archiveLegacyFiles(partialRepo, partialArchive);
        for (const required of ["docs/WORKFLOW-STATE.json", "docs/EXECUTION-AUDIT.jsonl", "docs/PROGRESS.md", "docs/artifacts"]) {
          assert(copied.includes(required), `pre-cutover archive is missing ${required}`);
        }
        assert(partialCopied.includes("docs/WORKFLOW-STATE.json"), "partial-history archive is missing its legacy state");
        must("git", ["bundle", "create", completeBundle, "--all"], legacyRepo);
        must("git", ["bundle", "verify", completeBundle], legacyRepo);
        must("git", ["bundle", "create", partialBundle, "--all"], partialRepo);
        must("git", ["bundle", "verify", partialBundle], partialRepo);
        details.legacyRunId = legacyRunId;
        details.legacyCheckpoint = "complete; all declared output files exist";
        details.archivedPaths = copied;
        details.partialArchivedPaths = partialCopied;
        details.gitBundles = [completeBundle, partialBundle];

        for (const repoRoot of [legacyRepo, partialRepo]) await requireLauncher(["runtime", "repo", "add", repoRoot]);
        await requireLauncher(["runtime", "start"]);
        const client = await connect();
        await waitForApi(client);

        const migratedRun = (await submit(client, legacyRepo)).runId;
        serviceRunId = migratedRun;
        const migratedFinal = await waitForTerminal(client, migratedRun, 180_000);
        assert(migratedFinal.status === "complete", `Dapr migration run ended ${migratedFinal.status}`);
        assert(migratedRun !== legacyRunId, "Dapr reused the legacy run ID");
        const migratedState = await runState(client, migratedRun);
        const migratedTask = migratedState.tasks.find((task) => task.taskId === "L1");
        assert(migratedTask?.logicalAttempt === 1, "completed legacy checkpoint was not executed as a fresh Dapr task");
        assert(readFileSync(legacyStatePath, "utf8") === legacyStateText, "Dapr changed the archived legacy state file");
        const oldLookup = await client.get(legacyRunId).then(
          () => "found",
          () => "not-imported",
        );
        assert(oldLookup === "not-imported", "Dapr exposed the legacy run as a service run");

        const partialRun = (await submit(client, partialRepo)).runId;
        const partialFinal = await waitForTerminal(client, partialRun, 180_000);
        assert(partialFinal.status === "complete", `fresh run for partial legacy history ended ${partialFinal.status}`);
        assert(partialRun !== partialLegacyRunId, "Dapr reused the partial legacy run ID");
        const partialStateAfterRun = await runState(client, partialRun);
        const partialTask = partialStateAfterRun.tasks.find((task) => task.taskId === "P1");
        assert(taskStatus(partialStateAfterRun, "P1") === "complete", "partial legacy history was not rerun from the manifest");
        assert(partialTask?.logicalAttempt === 1, "partial legacy task did not start as a fresh Dapr task");
        assert(readLegacyState(partialRepo).runId === partialLegacyRunId, "Dapr rewrote the partial legacy state");
        details.daprRuns = [migratedRun, partialRun];
        details.partialHistory = "not imported; manifest tasks ran as a new service run";
      },
    );
    if (!migrated) return;

    await report.scenario(
      "P7-02",
      "Stop Dapr writers before restoring legacy ownership without dropping post-cutover Git changes",
      async (details) => {
        useLauncherFrom(current);
        const postCutoverFile = path.join(legacyRepo, "post-cutover.txt");
        writeFileSync(postCutoverFile, `preserved ${nonce}\n`);
        must("git", ["add", "post-cutover.txt"], legacyRepo);
        must("git", ["commit", "--quiet", "-m", "post-cutover rehearsal change"], legacyRepo);
        postCutoverHead = must("git", ["rev-parse", "HEAD"], legacyRepo);

        const backup = await requireLauncher(["runtime", "backup", "--output", serviceBackup]);
        details.serviceBackupMs = backup.ms;
        details.serviceBackup = serviceBackup;
        const uncommittedFile = path.join(legacyRepo, "post-cutover-uncommitted.txt");
        writeFileSync(uncommittedFile, `preserved uncommitted ${nonce}\n`);
        await requireLauncher(["runtime", "stop"]);
        const running = ["postgres", "placement", "scheduler", "daprd", "forge"]
          .map((service) => [service, containerState(isolation, service)] as const)
          .filter(([, state]) => state === "running");
        assert(running.length === 0, `Dapr writers still running during rollback: ${JSON.stringify(running)}`);
        details.daprWritersStoppedBeforeRestore = true;

        writeFileSync(legacyStatePath, `${JSON.stringify({
          runId: serviceRunId,
          status: "complete",
          tasks: {},
        })}\n`);
        assert(readLegacyState(legacyRepo).runId === serviceRunId, "rollback fixture did not contain the simulated wrong run reference");
        copyFileSync(path.join(completeArchive, "docs", "WORKFLOW-STATE.json"), legacyStatePath);
        const restored = readLegacyState(legacyRepo);
        assert(restored.runId === legacyRunId && restored.status === "complete", "pre-cutover legacy state was not restored");

        const beforeRollbackRun = must("git", ["rev-parse", "HEAD"], legacyRepo);
        assert(beforeRollbackRun === postCutoverHead, "post-cutover commit changed before legacy ownership was restored");
        const rollbackRun = runLegacyEngine(engineRoot, legacyRepo);
        assert(rollbackRun.code === 0, `previous-release rollback run failed: ${rollbackRun.stderr || rollbackRun.stdout}`);
        const afterRollbackRun = must("git", ["rev-parse", "HEAD"], legacyRepo);
        assert(afterRollbackRun === postCutoverHead, "rollback discarded post-cutover Git changes");
        assert(existsSync(postCutoverFile), "post-cutover file was lost during rollback");
        assert(readFileSync(uncommittedFile, "utf8") === `preserved uncommitted ${nonce}\n`, "rollback discarded post-cutover uncommitted work");
        const stateAfterRollback = readLegacyState(legacyRepo);
        assert(stateAfterRollback.runId === legacyRunId && stateAfterRollback.runId !== serviceRunId, "Dapr history was fed into the legacy state file");
        validateCompletedLegacyCheckpoint(legacyRepo, stateAfterRollback);
        assert(existsSync(path.join(serviceBackup, "manifest.json")), "post-cutover Dapr backup is missing");

        details.previousRelease = previous;
        details.restoredLegacyRunId = stateAfterRollback.runId;
        details.daprRunId = serviceRunId;
        details.postCutoverHead = postCutoverHead;
        details.postCutoverCommitPreserved = true;
        details.uncommittedWorkPreserved = true;
        details.preCutoverGitBundlesVerified = existsSync(completeBundle) && existsSync(partialBundle);
        details.daprBackupPreserved = true;
      },
    );
  } finally {
    useLauncherFrom(current);
  }
}
