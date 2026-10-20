import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { detectRepoRoot } from "./paths.ts";
import { resolveResources } from "./resources.ts";
import { getRuntimeDataDir, readRuntimeApiAccess } from "./runtime.ts";
import { findRegisteredRepository } from "./runtime-repositories.ts";

const TERMINAL_STATUSES = new Set(["complete", "failed", "cancelled"]);
const CONTROL_ACTIONS = new Set(["pause", "resume", "stop", "cancel", "replay-task", "approve-task"]);
const FORGE_BRANCH_PREFIX = "forge/";

export class ServiceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Authenticated client for the local execution service API. */
export class ServiceClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async request<T = Record<string, unknown>>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ServiceApiError(0, "service-unreachable",
        `The local execution service is not reachable at ${this.baseUrl}; run "forge-launcher runtime start".`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ServiceApiError(response.status, "invalid-response", `The service returned a non-JSON response (${response.status}).`);
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } }).error;
      const message = error?.message ?? `Request failed (${response.status}).`;
      throw new ServiceApiError(response.status, error?.code ?? "request-failed", response.status === 401
        ? `${message} The service rejected the API token from runtime.env; if you ran "forge-launcher runtime rotate-tokens", ` +
          `run "forge-launcher runtime stop" and "forge-launcher runtime start" to apply it.`
        : message);
    }
    return parsed as T;
  }

  submit(submission: unknown) { return this.request("POST", "/v1/runs", submission); }
  list(repositoryId?: string) {
    return this.request<{ runs: Record<string, unknown>[] }>("GET",
      `/v1/runs${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ""}`);
  }
  get(runId: string) { return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}`); }
  events(runId: string, after: number, limit = 200) {
    return this.request<{ events: Record<string, unknown>[]; cursor: number; hasMore: boolean }>(
      "GET", `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`);
  }
  control(runId: string, action: string, payload: Record<string, unknown> = {}, controlId: string = randomUUID()) {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/controls`, { controlId, action, payload });
  }
}

export interface SubmissionInput {
  readonly manifest: Record<string, unknown> & { readonly phases: readonly unknown[] };
  readonly agents: readonly Record<string, unknown>[];
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly harness: string;
  readonly settings: Readonly<Record<string, number | boolean>>;
  readonly requestedTaskIds: readonly string[];
  readonly submissionKey?: string;
}

/** Builds a contract v1 run submission; agent descriptors are frozen into the snapshot. */
export function buildRunSubmission(
  input: SubmissionInput,
  computeManifestDigest: (snapshot: unknown) => string,
): Record<string, unknown> {
  const manifestSnapshot = {
    ...input.manifest,
    agents: input.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      path: agent.path,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.modelFallback === undefined ? {} : { modelFallback: agent.modelFallback }),
      expertise: agent.expertise,
      collaboration: agent.collaboration,
      constraints: agent.constraints,
      rawBody: agent.rawBody,
    })),
  };
  return {
    schemaVersion: 1,
    submissionKey: input.submissionKey ?? `cli-${randomUUID()}`,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    manifestSnapshot,
    manifestDigest: computeManifestDigest(manifestSnapshot),
    selection: input.requestedTaskIds.length
      ? { mode: "manual", requestedTaskIds: [...input.requestedTaskIds] }
      : { mode: "auto", requestedTaskIds: [] },
    harness: { id: input.harness, adapterVersion: "1" },
    configuration: { settings: { ...input.settings }, secretRefs: {} },
    workflowDefinitionVersion: "p5-03@1",
  };
}

function git(repoRoot: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/**
 * The service integrates into `refs/heads/forge/<branch>`, never the branch
 * checked out in the worktree. A new forge branch starts at HEAD; an existing
 * one fast-forwards to HEAD when HEAD contains it and is otherwise kept.
 */
export function prepareForgeBranch(repoRoot: string, branch?: string): { targetRef: string; created: boolean; note?: string } {
  let base = branch;
  if (!base) {
    const head = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!head.ok || !head.stdout) throw new Error("HEAD is detached; pass --branch <name> to choose the forge branch base.");
    base = head.stdout;
  }
  const forgeBranch = base.startsWith(FORGE_BRANCH_PREFIX) ? base : `${FORGE_BRANCH_PREFIX}${base}`;
  if (!git(repoRoot, ["check-ref-format", `refs/heads/${forgeBranch}`]).ok) {
    throw new Error(`'${forgeBranch}' is not a valid branch name.`);
  }
  const targetRef = `refs/heads/${forgeBranch}`;
  const current = git(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  if (current.ok && current.stdout === targetRef) {
    throw new Error(`${forgeBranch} is checked out; switch to its base branch before submitting.`);
  }
  const startPoint = branch ? `refs/heads/${base}` : "HEAD";
  const existing = git(repoRoot, ["rev-parse", "--verify", "--quiet", targetRef]);
  if (!existing.ok) {
    const created = git(repoRoot, ["branch", forgeBranch, startPoint]);
    if (!created.ok) throw new Error(`Could not create ${forgeBranch}: ${created.stderr}`);
    return { targetRef, created: true };
  }
  if (git(repoRoot, ["merge-base", "--is-ancestor", targetRef, startPoint]).ok) {
    const moved = git(repoRoot, ["update-ref", targetRef, startPoint, existing.stdout]);
    if (!moved.ok) throw new Error(`Could not fast-forward ${forgeBranch}: ${moved.stderr}`);
    return { targetRef, created: false };
  }
  return { targetRef, created: false, note: `${forgeBranch} has unmerged Forge commits; the run continues from them.` };
}

interface ExecutionModules {
  computeManifestDigest(snapshot: unknown): string;
  discoverForgeRepo(start: string, harnessRoot?: string): { agents: Record<string, unknown>[] };
}

async function loadExecutionModules(): Promise<ExecutionModules> {
  const { executionDir, templatesDir } = resolveResources();
  const contract = await tsImport(
    pathToFileURL(path.join(path.dirname(executionDir), "contract", "v1", "index.ts")).href, import.meta.url,
  ) as Pick<ExecutionModules, "computeManifestDigest">;
  const discovery = await tsImport(
    pathToFileURL(path.join(templatesDir, "skills", "forge-execution-adapter", "scripts", "discovery.ts")).href, import.meta.url,
  ) as Pick<ExecutionModules, "discoverForgeRepo">;
  return { computeManifestDigest: contract.computeManifestDigest, discoverForgeRepo: discovery.discoverForgeRepo };
}

function parseFlags(args: readonly string[], allowed: Record<string, "value" | "flag">): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const kind = allowed[argument];
    if (!kind) throw new Error(`Unknown option: ${argument}`);
    if (kind === "flag") {
      flags.set(argument, "true");
    } else {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      flags.set(argument, value);
    }
  }
  return { flags, positional };
}

function integerFlag(flags: Map<string, string>, name: string): number | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  return Number(value);
}

async function repositoryIdFor(repoRoot: string): Promise<string> {
  const entry = await findRegisteredRepository(getRuntimeDataDir(), repoRoot);
  if (!entry) {
    throw new Error(`${repoRoot} is not registered; run "forge-launcher runtime repo add ${repoRoot}" and restart the runtime.`);
  }
  return entry.id;
}

function formatEvent(event: Record<string, unknown>): string {
  const parts = [`#${event.sequence}`, String(event.eventType)];
  if (event.taskId) parts.push(`task=${event.taskId}`);
  if (event.logicalAttempt) parts.push(`attempt=${event.logicalAttempt}`);
  for (const key of ["runStatus", "taskStatus", "attemptStatus"] as const) {
    if (event[key]) parts.push(`${key}=${event[key]}`);
  }
  return parts.join(" ");
}

const SERVICE_USAGE = `Usage:
  forge-launcher service submit [--repo <path>] [--harness stub] [--branch <base>] [--tasks <id,id>]
                                [--concurrency <n>] [--max-retries <n>] [--retry-delay-ms <ms>]
                                [--allow-noop] [--key <submission-key>] [--follow]
  forge-launcher service runs [--repo <path>] [--json]
  forge-launcher service status <run-id> [--json]
  forge-launcher service events <run-id> [--after <n>] [--follow] [--json]
  forge-launcher service control <run-id> <pause|resume|stop|cancel|replay-task|approve-task> [--task <id>]
  forge-launcher service merge <run-id> [--repo <path>]

Submits runs to the local execution service ("forge-launcher runtime start").
The repository must be registered with "forge-launcher runtime repo add".
Runs integrate into forge/<base>, never the checked-out branch; "merge"
fast-forwards the checked-out branch to the run's forge branch.
The containerized worker currently provides only the stub harness; real
harness runs still use "forge-launcher engine-run".
--json prints the service API records unchanged: one JSON document for runs and
status, and one JSON event per line (NDJSON) for events.
`;

export async function serviceCli(
  args: readonly string[],
  dependencies: { readonly client?: ServiceClient; readonly write?: (text: string) => void } = {},
): Promise<number> {
  const [command, ...rest] = args;
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  if (!command || command === "--help" || command === "-h" || command === "help") {
    write(SERVICE_USAGE);
    return command ? 0 : 1;
  }
  const client = dependencies.client ?? await (async () => {
    const access = await readRuntimeApiAccess();
    return new ServiceClient(access.baseUrl, access.token);
  })();

  const follow = async (runId: string, after = 0, json = false): Promise<number> => {
    let cursor = after;
    for (;;) {
      const page = await client.events(runId, cursor);
      for (const event of page.events) write(`${json ? JSON.stringify(event) : formatEvent(event)}\n`);
      cursor = page.cursor;
      if (page.hasMore) continue;
      const run = await client.get(runId);
      if (TERMINAL_STATUSES.has(String(run.status))) {
        if (!json) write(`Run ${runId} is ${run.status}.\n`);
        return run.status === "complete" ? 0 : 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };

  switch (command) {
    case "submit": {
      const { flags, positional } = parseFlags(rest, {
        "--repo": "value", "--harness": "value", "--branch": "value", "--tasks": "value",
        "--concurrency": "value", "--max-retries": "value", "--retry-delay-ms": "value",
        "--allow-noop": "flag", "--key": "value", "--follow": "flag",
      });
      if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
      const repoRoot = detectRepoRoot(path.resolve(flags.get("--repo") ?? process.cwd()));
      const repositoryId = await repositoryIdFor(repoRoot);
      const manifestPath = path.join(repoRoot, "docs", "EXECUTION-MANIFEST.json");
      let manifest: SubmissionInput["manifest"];
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        throw new Error(`${manifestPath} is missing or invalid; run "forge-launcher compile-manifest" first.`);
      }
      const modules = await loadExecutionModules();
      const { agents } = modules.discoverForgeRepo(repoRoot, manifest.harnessRoot as string | undefined);
      const branch = prepareForgeBranch(repoRoot, flags.get("--branch"));
      if (branch.note) write(`${branch.note}\n`);
      const settings: Record<string, number | boolean> = {};
      for (const [flag, key] of [["--concurrency", "concurrency"], ["--max-retries", "maxRetries"], ["--retry-delay-ms", "retryDelayMs"]] as const) {
        const value = integerFlag(flags, flag);
        if (value !== undefined) settings[key] = value;
      }
      if (flags.has("--allow-noop")) settings.allowNoop = true;
      const submission = buildRunSubmission({
        manifest,
        agents,
        repositoryId,
        targetRef: branch.targetRef,
        harness: flags.get("--harness") ?? "stub",
        settings,
        requestedTaskIds: (flags.get("--tasks") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
        ...(flags.has("--key") ? { submissionKey: flags.get("--key")! } : {}),
      }, modules.computeManifestDigest);
      const result = await client.submit(submission);
      write(`${result.reused ? "Reused" : "Submitted"} run ${result.runId} -> ${branch.targetRef.slice("refs/heads/".length)} (${result.status}).\n`);
      return flags.has("--follow") ? follow(String(result.runId)) : 0;
    }
    case "runs": {
      const { flags, positional } = parseFlags(rest, { "--repo": "value", "--json": "flag" });
      if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
      const repositoryId = flags.has("--repo")
        ? await repositoryIdFor(detectRepoRoot(path.resolve(flags.get("--repo")!)))
        : undefined;
      const { runs } = await client.list(repositoryId);
      if (flags.has("--json")) {
        write(`${JSON.stringify({ runs }, null, 2)}\n`);
        return 0;
      }
      write(runs.length
        ? `${runs.map((run) => `${run.runId}\t${run.status}\t${run.repositoryId}\t${run.targetRef}\t${run.createdAt}`).join("\n")}\n`
        : "No service runs.\n");
      return 0;
    }
    case "status": {
      const { flags, positional } = parseFlags(rest, { "--json": "flag" });
      if (positional.length !== 1) throw new Error("Usage: forge-launcher service status <run-id> [--json]");
      const run = await client.get(positional[0]!);
      if (flags.has("--json")) {
        write(`${JSON.stringify(run, null, 2)}\n`);
        return 0;
      }
      const tasks = (run.tasks as { taskId: string; status: string; logicalAttempt?: number }[] | undefined) ?? [];
      write(`${run.runId}: ${run.status} (${run.repositoryId} ${run.targetRef}, harness ${(run.harness as { id: string }).id})\n`);
      for (const task of tasks) write(`  ${task.taskId}\t${task.status}${task.logicalAttempt ? `\tattempt ${task.logicalAttempt}` : ""}\n`);
      return 0;
    }
    case "events": {
      const { flags, positional } = parseFlags(rest, { "--after": "value", "--follow": "flag", "--json": "flag" });
      if (positional.length !== 1) throw new Error("Usage: forge-launcher service events <run-id> [--after <n>] [--follow] [--json]");
      const after = integerFlag(flags, "--after") ?? 0;
      const json = flags.has("--json");
      if (flags.has("--follow")) return follow(positional[0]!, after, json);
      // --json exports the complete audit trail; the text view shows one page.
      let cursor = after;
      for (;;) {
        const page = await client.events(positional[0]!, cursor);
        for (const event of page.events) write(`${json ? JSON.stringify(event) : formatEvent(event)}\n`);
        cursor = page.cursor;
        if (!page.hasMore) break;
        if (!json) {
          write(`More events follow; rerun with --after ${page.cursor}.\n`);
          break;
        }
      }
      return 0;
    }
    case "control": {
      const { flags, positional } = parseFlags(rest, { "--task": "value" });
      const [runId, action] = positional;
      if (!runId || !action || positional.length !== 2 || !CONTROL_ACTIONS.has(action)) {
        throw new Error(`Usage: forge-launcher service control <run-id> <${[...CONTROL_ACTIONS].join("|")}> [--task <id>]`);
      }
      const taskId = flags.get("--task");
      if ((action === "replay-task" || action === "approve-task") && !taskId) throw new Error(`${action} requires --task <id>.`);
      const result = await client.control(runId, action, taskId ? { taskId } : {});
      write(`Control ${result.action} ${result.controlId} is ${result.state}.\n`);
      return 0;
    }
    case "merge": {
      const { flags, positional } = parseFlags(rest, { "--repo": "value" });
      if (positional.length !== 1) throw new Error("Usage: forge-launcher service merge <run-id> [--repo <path>]");
      const repoRoot = detectRepoRoot(path.resolve(flags.get("--repo") ?? process.cwd()));
      const run = await client.get(positional[0]!);
      if (run.repositoryId !== await repositoryIdFor(repoRoot)) {
        throw new Error(`Run ${positional[0]} belongs to repository '${run.repositoryId}', not ${repoRoot}.`);
      }
      if (!TERMINAL_STATUSES.has(String(run.status))) throw new Error(`Run ${positional[0]} is still ${run.status}.`);
      const merged = git(repoRoot, ["merge", "--ff-only", String(run.targetRef)]);
      if (!merged.ok) throw new Error(`Fast-forward merge failed: ${merged.stderr || merged.stdout}`);
      write(`${merged.stdout || "Fast-forwarded."}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown service command: ${command}\n${SERVICE_USAGE}`);
  }
}
