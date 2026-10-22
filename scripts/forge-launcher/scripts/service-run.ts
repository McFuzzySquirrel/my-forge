import fs from "node:fs";
import path from "node:path";
import { loadEngineConfig } from "./engine-config.ts";
import { authoringReadiness } from "./authoring-state.ts";
import { runCommand } from "./format.ts";
import { detectRepoRoot } from "./paths.ts";
import { HARNESS_ROOTS, selectProjectHarnessRoot } from "./repo-metadata.ts";
import { getRuntimeDataDir, readRuntimeApiAccess } from "./runtime.ts";
import { findRegisteredRepository } from "./runtime-repositories.ts";
import {
  ServiceClient,
  followRun,
  git,
  latestActiveRun,
  latestEventCursor,
  submitRepositoryRun,
} from "./service-client.ts";

/**
 * Execution entry points select a deployment, not a scheduler: a repository
 * must be registered with the local runtime to run in the local execution
 * service. Unregistered repositories fail closed; hosted deployment is not
 * available yet.
 */
export function assertLocalDeployment(env: NodeJS.ProcessEnv = process.env): void {
  const value = env.FORGE_DEPLOYMENT?.trim().toLowerCase();
  if (!value || value === "local") return;
  if (value === "hosted") {
    throw new Error("FORGE_DEPLOYMENT=hosted is not available yet; unset it (or set it to 'local') to use the local execution service.");
  }
  throw new Error(`Unknown FORGE_DEPLOYMENT '${env.FORGE_DEPLOYMENT}'; the supported value is 'local'.`);
}

type RunClient = Pick<ServiceClient, "submit" | "list" | "get" | "events" | "control">;

export interface ServiceRunDependencies {
  readonly repositoryId?: (repoRoot: string) => Promise<string | undefined>;
  readonly client?: () => Promise<RunClient>;
  readonly write?: (text: string) => void;
  readonly compile?: (repoRoot: string, harnessRoot: string | null, granularity: string) => Promise<void>;
  readonly submit?: typeof submitRepositoryRun;
  readonly pollMs?: number;
}

async function registeredRepositoryId(repoRoot: string): Promise<string | undefined> {
  if (!fs.existsSync(repoRoot)) return undefined;
  return (await findRegisteredRepository(getRuntimeDataDir(), repoRoot))?.id;
}

function registrationError(repoRoot: string): Error {
  return new Error(
    `Repository is not registered with the local execution service: ${repoRoot}. ` +
    `Register it with "forge-launcher runtime repo add ${repoRoot}", restart the runtime, then retry. ` +
    "Legacy workflow histories are not imported.",
  );
}

export async function requireRegisteredRepository(repoRoot: string): Promise<string> {
  const repositoryId = await registeredRepositoryId(path.resolve(repoRoot));
  if (!repositoryId) throw registrationError(path.resolve(repoRoot));
  return repositoryId;
}

async function defaultClient(): Promise<RunClient> {
  const access = await readRuntimeApiAccess();
  return new ServiceClient(access.baseUrl, access.token);
}

/** Mirrors a command's progress to the terminal and docs/engine-run.log (read by the Console). */
function teeWriter(repoRoot: string): (text: string) => void {
  const logFile = path.join(repoRoot, "docs", "engine-run.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (text) => {
    if (process.stdout.isTTY) process.stdout.write(text);
    fs.appendFileSync(logFile, text);
  };
}

/** Flags the service owns itself; accepted from older scripts and saved settings but ignored. */
const IGNORED_FLAGS: Readonly<Record<string, string>> = {
  "--task-timeout-ms": "the service applies its own attempt budget",
  "--heartbeat-ms": "the service records progress events instead of heartbeats",
  "--viz": "use the Console Service runs view",
  "--viz-port": "use the Console Service runs view",
  "--no-open": "no dashboard is opened",
  "--run-validation": "the service runs task validation itself",
  "--log-harness-activity": "harness output stays in the service's attempt logs",
  "--no-log-harness-activity": "harness output stays in the service's attempt logs",
  "--auto-commit": "the service commits each completed task to forge/<branch>",
  "--no-auto-commit": "the service commits each completed task to forge/<branch>",
  "--commit-message-template": "the service writes its own checkpoint commits",
  "--yes": "service runs never prompt",
};
const VALUE_FLAGS = new Set([
  "--repo", "--harness", "--concurrency", "--task-timeout-ms", "--granularity", "--max-retries",
  "--retry-delay-ms", "--heartbeat-ms", "--viz-port", "--commit-message-template", "--execution-mode",
  "--selection-scope", "--selected-tasks",
]);
const BOOLEAN_FLAGS = new Set([
  "--yes", "--dry-run", "--viz", "--no-open", "--allow-noop", "--run-validation", "--log-harness-activity",
  "--no-log-harness-activity", "--auto-commit", "--no-auto-commit", "--stop", "--pause",
]);

function parseEngineRunArgs(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (VALUE_FLAGS.has(argument)) {
      const value = args[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      flags.set(argument, value);
    } else if (BOOLEAN_FLAGS.has(argument)) {
      flags.set(argument, "true");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return flags;
}

function integerSetting(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  return Number(value);
}

/** Compiles the manifest with the repository's bootstrapped execution adapter, as the legacy path did. */
async function compileManifest(repoRoot: string, harnessRoot: string | null, granularity: string): Promise<void> {
  const roots = harnessRoot ? [harnessRoot, ...HARNESS_ROOTS.filter((root) => root !== harnessRoot)] : HARNESS_ROOTS;
  const adapterDir = roots.map((root) => path.join(repoRoot, root, "skills", "forge-execution-adapter"))
    .find((directory) => fs.existsSync(directory));
  if (!adapterDir) throw new Error(`docs/EXECUTION-MANIFEST.json is missing and no forge-execution-adapter is bootstrapped; run "forge-launcher compile-manifest".`);
  const install = await runCommand("npm", ["install"], { cwd: adapterDir });
  if (install.code !== 0) throw new Error(`Execution-adapter dependency install failed (exit ${install.code}).`);
  const args = ["run", "forge-execution-adapter", "--", "compile", "--repo", repoRoot];
  if (harnessRoot) args.push("--harness-root", harnessRoot);
  if (granularity) args.push("--granularity", granularity);
  const compiled = await runCommand("npm", args, { cwd: adapterDir });
  if (compiled.code !== 0) {
    throw new Error(`Execution-manifest compile failed (exit ${compiled.code}).${compiled.stderr ? `\n${compiled.stderr.trim()}` : ""}`);
  }
}

/** Fast-forwards the checked-out base branch to a completed run's forge branch when possible. */
function integrateCompletedRun(repoRoot: string, runId: string, forgeBranch: string, write: (text: string) => void): void {
  const head = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.ok && `forge/${head.stdout}` === forgeBranch) {
    const merged = git(repoRoot, ["merge", "--ff-only", `refs/heads/${forgeBranch}`]);
    if (merged.ok) {
      write(`Fast-forwarded ${head.stdout} to ${forgeBranch}.\n`);
      return;
    }
    write(`Could not fast-forward ${head.stdout}: ${merged.stderr || merged.stdout}\n`);
  }
  write(`The run's commits are on ${forgeBranch}; merge them with: forge-launcher service merge ${runId} --repo "${repoRoot}"\n`);
}

/**
 * `engine-run` through the local service. Legacy execution is not a fallback.
 */
export async function serviceEngineRun(
  args: readonly string[],
  dependencies: ServiceRunDependencies = {},
): Promise<number> {
  assertLocalDeployment();
  const repoIndex = args.indexOf("--repo");
  const repoArgument = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  const repoRoot = repoArgument ? path.resolve(repoArgument) : detectRepoRoot();
  const repositoryId = await (dependencies.repositoryId ?? registeredRepositoryId)(repoRoot);
  if (!repositoryId) {
    throw registrationError(repoRoot);
  }
  const flags = parseEngineRunArgs(args);

  const write = dependencies.write ?? teeWriter(repoRoot);
  const dryRun = flags.has("--dry-run");
  const client = dryRun ? undefined : await (dependencies.client ?? defaultClient)();
  const resumeCommand = `forge-launcher engine-run --repo "${repoRoot}"`;

  if (flags.has("--stop") || flags.has("--pause")) {
    const action = flags.has("--stop") ? "stop" : "pause";
    if (!client) {
      write(`[dry-run] would send ${action} to the active service run for ${repositoryId}.\n`);
      return 0;
    }
    const active = await latestActiveRun(client, repositoryId);
    if (!active) {
      write(`No active service run for ${repoRoot}.\n`);
      return 0;
    }
    const result = await client.control(String(active.runId), action);
    write(`Control ${action} ${result.controlId} is ${result.state} for run ${active.runId}; ` +
      `the run pauses after its current task. Resume with: ${resumeCommand}\n`);
    return 0;
  }

  const harnessRoot = selectProjectHarnessRoot(repoRoot).root;
  const readiness = authoringReadiness(repoRoot, harnessRoot ?? ".agents");
  if (!readiness.ready) throw new Error(readiness.reason ?? "Authoring must finish before execution.");
  const harness = flags.get("--harness") ?? process.env.FORGE_ENGINE_HARNESS ?? loadEngineConfig(repoRoot)?.harness ?? "opencode";
  const granularity = flags.get("--granularity") ?? process.env.FORGE_ENGINE_GRANULARITY ?? "";
  if (granularity && granularity !== "fine" && granularity !== "coarse") {
    throw new Error(`Invalid --granularity '${granularity}'. Choose 'fine' or 'coarse'.`);
  }
  const executionMode = flags.get("--execution-mode") ?? "auto";
  if (executionMode !== "auto" && executionMode !== "manual") {
    throw new Error(`Invalid --execution-mode '${executionMode}'. Choose 'auto' or 'manual'.`);
  }
  const requestedTaskIds = executionMode === "manual"
    ? (flags.get("--selected-tasks") ?? "").split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  if (executionMode === "manual" && requestedTaskIds.length === 0) {
    throw new Error("Manual execution needs --selected-tasks <id,id,...>.");
  }
  const settings: Record<string, number | boolean> = {};
  const numeric = [
    ["--concurrency", "FORGE_ENGINE_CONCURRENCY", "concurrency"],
    ["--max-retries", "FORGE_ENGINE_MAX_RETRIES", "maxRetries"],
    ["--retry-delay-ms", "FORGE_ENGINE_RETRY_DELAY_MS", "retryDelayMs"],
  ] as const;
  for (const [flag, variable, key] of numeric) {
    const value = integerSetting(flags.get(flag) ?? process.env[variable], flag);
    if (value !== undefined) settings[key] = value;
  }
  if (flags.has("--allow-noop") || process.env.FORGE_ENGINE_ALLOW_NOOP === "1") settings.allowNoop = true;

  write(`forge-engine-run: repo=${repoRoot} deployment=local service repository=${repositoryId} harness=${harness}\n`);
  const ignored = [...flags.keys()].filter((flag) => IGNORED_FLAGS[flag] && flag !== "--yes" && flag !== "--no-open");
  for (const flag of ignored) write(`  Note: ${flag} is ignored for service runs (${IGNORED_FLAGS[flag]}).\n`);

  const manifest = path.join(repoRoot, "docs", "EXECUTION-MANIFEST.json");
  if (!fs.existsSync(manifest) || granularity) {
    if (dryRun) write(`  [dry-run] would compile ${manifest}${granularity ? ` (granularity ${granularity})` : ""}.\n`);
    else {
      write(`  Compiling ${manifest}${granularity ? ` (granularity ${granularity})` : ""}.\n`);
      await (dependencies.compile ?? compileManifest)(repoRoot, harnessRoot, granularity);
    }
  }
  if (!client) {
    write(`  [dry-run] would resume the active service run or submit a new one with ${JSON.stringify({ harness, settings, requestedTaskIds })}.\n`);
    return 0;
  }

  const active = await latestActiveRun(client, repositoryId);
  let runId: string;
  let forgeBranch: string;
  let after = 0;
  if (active) {
    runId = String(active.runId);
    const runHarness = (active.harness as { id?: unknown } | undefined)?.id;
    if (typeof runHarness === "string" && runHarness !== harness) {
      write(`  Note: the active run keeps its harness (${runHarness}); --harness applies only to new runs.\n`);
    }
    forgeBranch = String(active.targetRef).replace(/^refs\/heads\//, "");
    after = await latestEventCursor(client, runId);
    if (active.status === "paused" || active.status === "pausing") {
      const result = await client.control(runId, "resume");
      write(`Resuming service run ${runId} (control ${result.controlId} ${result.state}); new settings apply only to new runs.\n`);
    } else {
      write(`Attaching to service run ${runId} (${active.status}); only one run per repository is active at a time.\n`);
    }
  } else {
    const submitted = await (dependencies.submit ?? submitRepositoryRun)(client, {
      repoRoot, repositoryId, harness, settings, requestedTaskIds,
    }, write);
    runId = submitted.runId;
    forgeBranch = submitted.forgeBranch;
    write(`${submitted.reused ? "Reused" : "Submitted"} service run ${runId} -> ${forgeBranch} (${submitted.status}).\n`);
  }
  write(`  Monitor: forge-launcher service events ${runId} --follow  (or the Console Service runs view)\n`);
  const code = await followRun(client, runId, write, { after, returnOnPause: true, pollMs: dependencies.pollMs });
  const run = await client.get(runId);
  if (run.status === "complete") integrateCompletedRun(repoRoot, runId, forgeBranch, write);
  else if (run.status === "paused") write(`Resume with: ${resumeCommand}\n`);
  return code;
}

/**
 * `resume` for a registered repository: resumes or attaches to the active
 * service run. Returns undefined when the repository is not registered or has
 * no active run, so the caller continues with the authoring-stage resume flow.
 */
export async function serviceResume(
  options: { readonly repo?: string; readonly nonInteractive?: boolean; readonly dryRun?: boolean },
  dependencies: ServiceRunDependencies = {},
): Promise<number | undefined> {
  const repoRoot = options.repo ? path.resolve(options.repo) : detectRepoRoot();
  assertLocalDeployment();
  const repositoryId = await (dependencies.repositoryId ?? registeredRepositoryId)(repoRoot);
  if (!repositoryId) return undefined;
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  const client = await (dependencies.client ?? defaultClient)();
  const active = await latestActiveRun(client, repositoryId);
  if (!active) return undefined;
  const runId = String(active.runId);
  if (options.nonInteractive || options.dryRun) {
    write(`Service run ${runId} is ${active.status} for ${repoRoot}.\n`);
    write(`  Next: forge-launcher engine-run --repo "${repoRoot}"   (resumes or attaches)\n`);
    write(`  Monitor: forge-launcher service events ${runId} --follow\n`);
    return 0;
  }
  return serviceEngineRun(["--repo", repoRoot], { ...dependencies, write: dependencies.write });
}
