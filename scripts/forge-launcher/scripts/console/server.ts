import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { tsImport } from "tsx/esm/api";

import { resolveResources } from "../resources.ts";
import { resolveInputFile } from "../paths.ts";
import { launchCliInTerminal } from "../terminal.ts";
import { RunController, type ControlDeps } from "./control.ts";
import { layoutGantt } from "./board-gantt.ts";
import { layoutManifest } from "./board-layout.ts";
import { IncrementalLineReader } from "./incremental-reader.ts";
import { consoleAuthoringInventory, selectedAuthoringRunner } from "./authoring.ts";
import { isRunnerChoice, loadAuthoringConfig, saveAuthoringConfig, validateAuthoringConfig } from "../authoring-config.ts";
import { interactiveAuthoringArgv, resolveAuthoringModel, type InventoryProbe } from "../authoring-inventory.ts";
import { validateAuthoredPrd } from "../prd-validation.ts";
import { loadEngineConfig } from "../engine-config.ts";
import { featureIncrementHandoffHasChange, recordAuthoringStageSuccess, recordFeatureIncrementHandoff } from "../authoring-state.ts";
import { REDERIVE_STEPS, rederiveProgress, type RederiveStepId } from "../rederive-state.ts";
import {
  detectHarnessRoot,
  loadRegistry,
  looksLikeForgeRepo,
  repoPaths,
  upsertProject,
} from "./paths.ts";
import { harnessCliForHarness } from "./dashboard/harness-rules.ts";
import * as repo from "./repo.ts";
import { removeProjects, sameProjectPath } from "./remove-projects.ts";
import { OperatorSessions, SIGN_IN_PATH } from "./session.ts";
import { controlServiceRun, routeServiceControl, defaultServiceRunsDeps, latestServiceRun, listServiceRuns, serviceRunDetail, type ServiceRunsDeps } from "./service-runs.ts";
import { defaultHostRunnerJobsDeps, listHostRunnerJobs, type HostRunnerJobsDeps } from "./host-runner-jobs.ts";
import type { ControlAction, CreateProjectRequest, Executor, ManifestTask, RunnerReadiness, ServiceRunSnapshot } from "./types.ts";
import {
  executeRuntimeAdminAction,
  getHostRunnerReadiness,
  getRuntimeAdminState,
  getRuntimeDataDir,
  parseRuntimeAdminAction,
  type RuntimeAdminAction,
  type RuntimeAdminResult,
  type RuntimeAdminState,
} from "../runtime.ts";

const CLIENT_DIR = fileURLToPath(new URL("../../resources/console/client", import.meta.url));

const DEFAULT_PORT = 4300;
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_MS = 15_000;
const FORGE_EVENT_PREFIX = "FORGE_EVENT ";

export interface ConsoleServerOptions {
  /** Initial repo to open (optional; when absent the landing/picker shows). */
  repoRoot?: string;
  port?: number;
  open?: boolean;
  onLog?: (message: string) => void;
  /** Test overrides. */
  clientDir?: string;
  boardDir?: string;
  deps?: ControlDeps;
  allowExternalOpen?: boolean;
  /** Injectable "launch a harness CLI in a terminal" seam (defaults to launchCliInTerminal). */
  launchCli?: (cli: string, dir: string, args: string[]) => Promise<boolean>;
  inventoryProbe?: InventoryProbe;
  /** Execution-service access seam (defaults to the local runtime API). */
  serviceRuns?: ServiceRunsDeps;
  /** Host-runner monitor seam (defaults to the local runtime API). */
  hostRunnerJobs?: HostRunnerJobsDeps;
  /** Runtime administration seam (defaults to the local Podman runtime). */
  runtimeAdmin?: RuntimeAdminDeps;
  /** Host-runner readiness seam (defaults to the local runtime registry). */
  runnerReadiness?: (repoRoot: string) => Promise<RunnerReadiness>;
}

export interface RuntimeAdminDeps {
  state(): Promise<RuntimeAdminState>;
  execute(action: RuntimeAdminAction): Promise<RuntimeAdminResult>;
}

export interface ConsoleServer {
  url: string;
  port: number;
  token: string;
  /** Mints a single-use link that signs a browser in to this Console. */
  signInUrl(): string;
  selectRepo(repoRoot: string): void;
  stop(): Promise<void>;
}

function boardDir(): string {
  const { usingBundled } = resolveResources();
  if (!usingBundled) return path.join(path.dirname(fileURLToPath(import.meta.url)), "board-assets");
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(packageDir, "resources", "console", "board-assets");
}

function asServiceRunSnapshot(value: unknown): ServiceRunSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.runId !== "string" || typeof run.status !== "string") return null;
  const tasks = Array.isArray(run.tasks)
    ? run.tasks.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const task = item as Record<string, unknown>;
      if (typeof task.taskId !== "string" || typeof task.status !== "string") return [];
      const attempts = Array.isArray(task.attempts)
        ? task.attempts.filter((attempt): attempt is Record<string, unknown> =>
          Boolean(attempt) && typeof attempt === "object")
        : [];
      const observedStart = attempts
        .map((attempt) => attempt.observedAt)
        .find((timestamp): timestamp is string => typeof timestamp === "string");
      return [{
        taskId: task.taskId,
        status: task.status,
        ...(typeof task.logicalAttempt === "number" ? { logicalAttempt: task.logicalAttempt } : {}),
        ...(observedStart ? { startedAt: observedStart } : {}),
        ...(typeof task.updatedAt === "string" && ["complete", "failed", "skipped", "cancelled"].includes(task.status)
          ? { completedAt: task.updatedAt }
          : {}),
      }];
    })
    : [];
  return {
    runId: run.runId,
    status: run.status,
    ...(typeof run.createdAt === "string" ? { createdAt: run.createdAt } : {}),
    ...(typeof run.updatedAt === "string" ? { updatedAt: run.updatedAt } : {}),
    ...(typeof run.hostExecution === "boolean" ? { hostExecution: run.hostExecution } : {}),
    tasks,
  };
}

// ─── Board layout ─────────────────────────────────────────────────────────────
//
// The Console used to answer `/api/layout` with `null`, so the embedded board
// re-derived its own geometry in JavaScript (`kanbanFromManifest`) while the
// tested TypeScript layout in the engine served only the standalone `--viz`
// server. That is two implementations of the same board, and for the Gantt —
// whose forecast must agree with the engine's dispatch rule — it would be two
// implementations of a scheduling algorithm.
//
// These Console-owned layout modules are pure and shared by both the API and
// their focused tests.

/**
 * Durations observed so far in this run, keyed by task id.
 *
 * Harvested from `task.complete` audit events rather than only from current state
 * so a task that failed and was retried contributes every attempt, which is what
 * makes the median meaningful. This is the Gantt's best available evidence; the
 * estimate ladder falls back to the owning agent's median and then a constant.
 */
function observedDurations(audit: ReturnType<typeof repo.loadAudit>): Record<string, number[]> {
  const samples: Record<string, number[]> = {};
  for (const event of audit) {
    if (event.action !== "task.complete" || !event.taskId || typeof event.durationMs !== "number") continue;
    if (!Number.isFinite(event.durationMs) || event.durationMs <= 0) continue;
    (samples[event.taskId] ??= []).push(event.durationMs);
  }
  return samples;
}

async function buildLayout(
  repoRoot: string,
  serviceRun: ServiceRunSnapshot | null = null,
): Promise<unknown> {
  const p = repoPaths(repoRoot);
  const manifest = repo.loadManifest(p);
  if (!manifest) return null;
  const state = serviceRun ? {
    startedAt: serviceRun.createdAt,
    tasks: Object.fromEntries(serviceRun.tasks.map((task) => [task.taskId, {
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    }])),
  } : null;
  const concurrency = Math.max(0, Number(loadEngineConfig(repoRoot)?.concurrency) || 0);
  return {
    kanban: layoutManifest(manifest, {}),
    gantt: layoutGantt(manifest, state, {
      concurrency,
      observedDurationsMs: observedDurations(repo.loadAudit(p)),
    }),
  };
}

/**
 * Keeps the reviewer's notes for a human review approved through the service:
 * the service binds the approval to its own evidence, and this readable
 * record names the run and control that carried it.
 */
async function writeServiceReviewRecord(
  repoRoot: string,
  taskId: string,
  reviewer: string,
  notes: string,
  approval: { runId?: unknown; controlId?: unknown },
): Promise<string> {
  const executionDir = resolveResources().executionDir;
  const context = await tsImport(pathToFileURL(path.join(executionDir, "task-context.ts")).href, import.meta.url) as {
    writeHumanReviewEvidence: (repoRoot: string, task: ManifestTask, reviewer: string, notes: string) => string;
  };
  const task = repo.loadManifest(repoPaths(repoRoot))?.phases.flatMap((phase) => phase.tasks).find((entry) => entry.id === taskId);
  if (!task) throw new Error(`Unknown task '${taskId}'.`);
  const record = context.writeHumanReviewEvidence(repoRoot, task, reviewer, notes);
  fs.appendFileSync(path.join(repoRoot, record), `\n## Service approval\n\nRun: ${String(approval.runId)}\nControl: ${String(approval.controlId)}\n`);
  return record;
}

async function findFreePort(start: number, onLog: (m: string) => void): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = start + attempt;
    const server: Server = http.createServer();
    const free = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  onLog(`  console: no free port found starting at ${start}`);
  throw new Error(`No free port available starting at ${start}`);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // spawn reports missing launchers asynchronously; keep browser opening
    // best-effort rather than allowing an unhandled ChildProcess error.
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // best-effort
  }
}

function openPath(filePath: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "darwin") {
    command = "open";
    args = [filePath];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", filePath];
  } else {
    command = "xdg-open";
    args = [filePath];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref?.();
  } catch {
    // best-effort
  }
}

/** Chooses the harness CLI + launch args for a forge repo (github → copilot, claude → claude, else opencode). */
function harnessCli(repoRoot: string): { cli: string; args: string[] } {
  return harnessCliForHarness(detectHarnessRoot(repoRoot));
}

// ─── Interactive authoring sessions ──────────────────────────────────────────
//
// The Console cannot interview a user in the browser, so the interactive path
// opens the authoring runner in a terminal with the skill already queued. The
// headless path remains available through /api/control.

type AuthoringSessionTarget = "idea" | "prd" | "feature-prd";

interface AuthoringSessionSpec {
  /** Authoring stage used to resolve the configured model for this session. */
  stage: "prd";
  skill: string;
  /** Builds the pre-seeded prompt; `prompt` is only set for feature-prd. */
  message: (prompt: string) => string;
}

const AUTHORING_SESSIONS: Record<AuthoringSessionTarget, AuthoringSessionSpec> = {
  idea: {
    stage: "prd",
    skill: "forge-grill-idea",
    message: () => "/forge-grill-idea Read docs/IDEA.md and any docs/research/*.md, then grill me in rounds to sharpen the idea. After I confirm shared understanding, rewrite docs/IDEA.md (and the root IDEA.md copy) and commit. Do not author the PRD, generate the team, or start a build.",
  },
  prd: {
    stage: "prd",
    skill: "forge-auto-build-prd",
    message: () => "/forge-auto-build-prd Use docs/IDEA.md and any docs/requirements-source.md as source material when present; otherwise inspect the existing repository (code, docs, tests, git history). Interactive mode: do NOT skip the interview. Ask your clarifying questions in rounds and wait for my answers, then author docs/PRD.md plus docs/features/*.md. Run validate-prd and commit. Do not generate the team or project skills, compile a manifest, or start a build.",
  },
  "feature-prd": {
    stage: "prd",
    skill: "forge-build-feature-prd",
    message: (prompt) => `/forge-build-feature-prd I want to add ${prompt} to this project. Analyze the existing PRD, features, codebase and team, interview me for any gaps, then author the new canonical feature under docs/features/ and register it in the PRD feature table. Run validate-prd and commit. Do not generate agents or skills, compile a manifest, or start the engine.`,
  },
};

/** Staging dir for browser-uploaded PRD/research files (needed before the new repo exists). */
function uploadStagingDir(): string {
  return path.join(os.tmpdir(), "forge-console-uploads", randomBytes(6).toString("hex"));
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name.trim());
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || `upload-${randomBytes(4).toString("hex")}.txt`;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// The new link goes only to the terminal: a page that showed it would hand a
// session to anything able to load this URL.
function sendSignInRequired(res: http.ServerResponse, sessions: OperatorSessions, onLog: (m: string) => void, reason: string): void {
  onLog(`  forge console sign-in link: ${sessions.issueSignInUrl()}`);
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Forge Console sign-in</title>
<p>${reason}</p>
<p>A new single-use sign-in link was printed in the terminal running <code>forge-launcher console</code>. Open that link to continue.</p>`);
}

function sendText(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

/** Reads a file from disk, resolved and confined within baseDir (no traversal). */
function readStatic(baseDir: string, urlPath: string): { body: Buffer; type: string } | null {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const resolved = path.resolve(baseDir, relative);
  const base = path.resolve(baseDir) + path.sep;
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(base)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const ext = path.extname(resolved);
  return { body: fs.readFileSync(resolved), type: MIME[ext] ?? "application/octet-stream" };
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function startConsoleServer(options: ConsoleServerOptions = {}): Promise<ConsoleServer> {
  const clientDir = options.clientDir ?? CLIENT_DIR;
  const boardAssets = options.boardDir ?? boardDir();
  const onLog = options.onLog ?? ((m: string) => console.log(m));
  // The Console exists to open terminals on the user's behalf, so it opts out of
  // the no-TTY guard the launcher applies to its own handoffs.
  const launchCli = options.launchCli
    ?? ((cli: string, dir: string, args: string[]) => launchCliInTerminal(cli, dir, args, { allowWithoutTty: true }));
  const token = randomBytes(16).toString("hex");

  const controller = new RunController(options.repoRoot ?? "", options.deps);

  let currentRepo: string | null = options.repoRoot ?? null;
  const auditReader = new IncrementalLineReader({ partialLinePolicy: "hold" });
  const logReader = new IncrementalLineReader({ partialLinePolicy: "emit" });
  const runtimeReader = new IncrementalLineReader({ partialLinePolicy: "emit" });
  const runtimeLogPath = path.join(getRuntimeDataDir(), "host-runner.log");
  const authoringReader = new IncrementalLineReader({ partialLinePolicy: "hold" });

  const currentPaths = () => (currentRepo ? repoPaths(currentRepo) : null);

  const port = await findFreePort(options.port ?? DEFAULT_PORT, onLog);
  const url = `http://127.0.0.1:${port}`;
  const sessions = new OperatorSessions({ port });
  let serviceRunsDeps = options.serviceRuns;
  const serviceRuns = (): ServiceRunsDeps => (serviceRunsDeps ??= defaultServiceRunsDeps());
  let hostRunnerJobsDeps = options.hostRunnerJobs;
  const hostRunnerJobs = (): HostRunnerJobsDeps => (hostRunnerJobsDeps ??= defaultHostRunnerJobsDeps());
  let runtimeAdminBusy = false;
  const runtimeAdmin: RuntimeAdminDeps = options.runtimeAdmin ?? {
    state: () => getRuntimeAdminState(),
    execute: (action) => executeRuntimeAdminAction(action),
  };
  const runnerReadiness = options.runnerReadiness ??
    ((repoRoot: string) => getHostRunnerReadiness(repoRoot));
  // The Overview refreshes on audit and snapshot events, so cache the answer
  // for a few seconds. The run preflight below still checks fresh state; the
  // service re-checks anyway.
  let readinessCache: { repoRoot: string; fetchedAt: number; value: RunnerReadiness } | null = null;
  const cachedRunnerReadiness = async (repoRoot: string): Promise<RunnerReadiness> => {
    const now = Date.now();
    if (readinessCache?.repoRoot === repoRoot && now - readinessCache.fetchedAt < 3000) {
      return readinessCache.value;
    }
    const value = await runnerReadiness(repoRoot);
    readinessCache = { repoRoot, fetchedAt: now, value };
    return value;
  };
  let serviceRunCache: {
    repoRoot: string;
    expiresAt: number;
    value: Promise<ServiceRunSnapshot | null>;
  } | null = null;
  function currentServiceRun(repoRoot: string | null): Promise<ServiceRunSnapshot | null> {
    if (!repoRoot) return Promise.resolve(null);
    if (serviceRunCache?.repoRoot === repoRoot && serviceRunCache.expiresAt > Date.now()) {
      return serviceRunCache.value;
    }
    const value = latestServiceRun(serviceRuns(), repoRoot).then((response) =>
      response.status === 200 && response.body.available === true
        ? asServiceRunSnapshot(response.body.run)
        : null);
    serviceRunCache = { repoRoot, expiresAt: Date.now() + 1000, value };
    return value;
  }

  // ── SSE clients ────────────────────────────────────────────────────────────
  type Send = (event: string, data: unknown) => void;
  const clients = new Set<Send>();

  function broadcast(event: string, data: unknown): void {
    for (const send of clients) send(event, data);
  }

  function snapshotEvent(): unknown {
    const p = currentPaths();
    if (!p) return { summary: null, manifest: null, layout: null };
    // Each source is read independently. A repository in a half-authored state (a
    // harness root that does not exist yet, an unreadable manifest) must not take
    // down the whole event stream, or every other view stops updating as well.
    const safe = <T,>(read: () => T): T | null => {
      try {
        return read();
      } catch (error) {
        onLog(`console snapshot: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    return {
      summary: safe(() => repo.summary(p)),
      manifest: safe(() => repo.loadManifest(p)),
      layout: null,
    };
  }

  function resetOffsets(): void {
    const p = currentPaths();
    auditReader.reset(p?.auditPath, true);
    logReader.reset(p?.logPath, true);
    authoringReader.reset(p?.logPath, true);
  }

  // ── Audit/log tailing (single poller, follows the current repo) ────────────
  resetOffsets();
  runtimeReader.reset(runtimeLogPath, true);

  const poller = setInterval(() => {
    try {
      const jobsChanged = repo.refreshJobs();
      const p = currentPaths();
      if (p) {
        try {
          for (const line of auditReader.read(p.auditPath).lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              broadcast("audit", JSON.parse(trimmed));
            } catch (error) {
              onLog(`  console: invalid audit record: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          onLog(`  console: failed to read audit log: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          for (const line of logReader.read(p.logPath).lines) {
            broadcast("log", { source: "engine", line });
          }
          for (const line of authoringReader.read(p.logPath).lines) {
            if (line.startsWith(FORGE_EVENT_PREFIX)) {
              try {
                const event = JSON.parse(line.slice(FORGE_EVENT_PREFIX.length));
                if (event && typeof event.type === "string") broadcast("authoring", event);
              } catch (error) {
                onLog(`  console: invalid authoring record: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        } catch (error) {
          onLog(`  console: failed to read engine log: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          for (const line of runtimeReader.read(runtimeLogPath).lines) {
            broadcast("log", { source: "runtime", line });
          }
        } catch (error) {
          onLog(`  console: failed to read runtime log: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (jobsChanged) broadcast("snapshot", snapshotEvent());
    } catch (error) {
      onLog(`  console: poller error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, POLL_INTERVAL_MS);
  poller.unref?.();

  // ── Request handler ────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? "/";
    const urlPath = rawUrl.split("?")[0]!;
    const method = req.method ?? "GET";

    try {
      const access = sessions.checkOrigin({ host: req.headers.host, origin: req.headers.origin });
      if (!access.ok) return sendText(res, access.status, access.reason);

      if (urlPath === SIGN_IN_PATH && method === "GET") {
        const capability = new URLSearchParams(rawUrl.split("?")[1] ?? "").get("capability");
        const cookie = sessions.exchange(capability);
        if (!cookie) return sendSignInRequired(res, sessions, onLog, "This sign-in link has expired or was already used.");
        res.writeHead(303, { "Set-Cookie": cookie, Location: "/", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (!sessions.hasSession(req.headers.cookie)) {
        if (urlPath.startsWith("/api/")) {
          return sendJson(res, 401, { ok: false, message: "Console session required. Open the sign-in link printed by forge-launcher console." });
        }
        return sendSignInRequired(res, sessions, onLog, "This browser is not signed in to the Forge Console.");
      }
      const authorized = req.headers["x-forge-token"] === token;

      // SSE
      if (urlPath === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 1500\n\n");
        const send: Send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        clients.add(send);
        send("snapshot", snapshotEvent());
        const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
        heartbeat.unref?.();
        req.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(send);
        });
        return;
      }

      // Read endpoints
      if (method === "GET") {
        const p = currentPaths();
        switch (urlPath) {
          case "/api/runtime":
            return sendJson(res, 200, await runtimeAdmin.state());
          case "/api/runner-readiness":
            return sendJson(res, 200, p ? await cachedRunnerReadiness(p.repoRoot) : null);
          case "/api/summary":
            repo.refreshJobs();
            return p ? sendJson(res, 200, repo.summary(p, await currentServiceRun(currentRepo))) : sendJson(res, 200, null);
          case "/api/tasks":
            return p ? sendJson(res, 200, repo.tasks(p, await currentServiceRun(currentRepo))) : sendJson(res, 200, []);
          case "/api/audit":
            return p ? sendJson(res, 200, repo.loadAudit(p)) : sendJson(res, 200, []);
          case "/api/authoring-events":
            return p ? sendJson(res, 200, repo.authoringEvents(p)) : sendJson(res, 200, []);
          case "/api/logs": {
            const q = new URLSearchParams(rawUrl.split("?")[1] ?? "");
            const lines = Number(q.get("lines") ?? "400");
            const count = Number.isInteger(lines) && lines > 0 ? lines : 400;
            const source = q.get("source") ?? "engine";
            if (source === "runtime") return sendJson(res, 200, repo.logLines(runtimeLogPath, count));
            if (source !== "engine") return sendJson(res, 400, { message: "Unknown log source." });
            if (!p) return sendJson(res, 200, { lines: [], truncated: false });
            return sendJson(res, 200, repo.logs(p, count));
          }
          case "/api/artifacts":
            return p ? sendJson(res, 200, repo.artifacts(p)) : sendJson(res, 200, { artifacts: [], types: [] });
          case "/api/docs":
            return p ? sendJson(res, 200, repo.docsIndex(p)) : sendJson(res, 200, { entries: [] });
          case "/api/team":
            return p ? sendJson(res, 200, repo.team(p)) : sendJson(res, 200, { harnessRoot: null, agents: [], skills: [] });
          case "/api/model-inventory":
            return p ? sendJson(res, 200, repo.modelInventory(p)) : sendJson(res, 200, { models: [] });
          case "/api/authoring-config":
            return sendJson(res, 200, p ? loadAuthoringConfig(p.repoRoot) : { version: 1, models: {} });
          case "/api/authoring-inventory": {
            const query = new URLSearchParams(rawUrl.split("?")[1] ?? "");
            return sendJson(res, 200, await consoleAuthoringInventory(p?.repoRoot, query.get("runner") ?? undefined));
          }
          case "/api/actions":
            return p ? sendJson(res, 200, repo.actions(p, await currentServiceRun(currentRepo))) : sendJson(res, 200, { canRun: false, canResume: false, canPause: false, canStop: false, failedTasks: [] });
          case "/api/rederive":
            return p ? sendJson(res, 200, rederiveProgress(p.repoRoot)) : sendJson(res, 200, null);
          case "/api/projects": {
            repo.refreshJobs();
            const projects = loadRegistry()
              .map((pr) => ({ ...pr, stage: repo.projectDisplayStage(pr.path), job: repo.projectInfo(pr.path).job }))
              .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
            return sendJson(res, 200, { projects, current: currentRepo });
          }
          case "/api/manifest":
            return p ? sendJson(res, 200, repo.loadManifest(p)) : sendJson(res, 200, null);
          case "/api/layout":
            if (!p) return sendJson(res, 200, null);
            return buildLayout(p.repoRoot, await currentServiceRun(currentRepo))
              .then((layout) => sendJson(res, 200, layout))
              .catch((error: unknown) => {
                // The board degrades to its own client-side geometry rather than
                // showing nothing, so a layout failure must not blank the view.
                onLog(`board layout unavailable: ${error instanceof Error ? error.message : String(error)}`);
                return sendJson(res, 200, null);
              });
        }

        if (urlPath === "/api/service/runs") {
          const result = await listServiceRuns(serviceRuns(), currentRepo);
          return sendJson(res, result.status, result.body);
        }
        if (urlPath === "/api/service/host-runner/jobs") {
          const query = new URLSearchParams(rawUrl.split("?")[1] ?? "");
          const result = await listHostRunnerJobs(hostRunnerJobs(), query.get("repositoryId") ?? undefined);
          return sendJson(res, result.status, result.body);
        }
        if (urlPath === "/api/service/run") {
          const q = new URLSearchParams(rawUrl.split("?")[1] ?? "");
          const result = await serviceRunDetail(serviceRuns(), currentRepo, q.get("id"), q.get("after"));
          return sendJson(res, result.status, result.body);
        }

        if (urlPath.startsWith("/api/artifacts/")) {
          if (!p) return sendJson(res, 404, null);
          const id = decodeURIComponent(urlPath.slice("/api/artifacts/".length));
          return sendJson(res, 200, repo.artifactById(p, id));
        }
        if (urlPath === "/api/artifact/content") {
          if (!p) return sendJson(res, 404, null);
          const q = new URLSearchParams(rawUrl.split("?")[1] ?? "");
          const rel = q.get("path") ?? "";
          const content = repo.readArtifactContent(p, rel);
          return content ? sendJson(res, 200, content) : sendJson(res, 404, null);
        }
        if (urlPath === "/api/docs/content" || urlPath === "/api/team/content") {
          if (!p) return sendJson(res, 404, null);
          const q = new URLSearchParams(rawUrl.split("?")[1] ?? "");
          const rel = q.get("path") ?? "";
          const content = repo.readDocContent(p, rel);
          return content ? sendJson(res, 200, content) : sendJson(res, 404, null);
        }
      }

      // POST endpoints (token-gated)
      if (method === "POST") {
        if (!authorized) return sendText(res, 403, "forbidden");
        const body = (await readBody(req)) as Record<string, unknown>;

        if (urlPath === "/api/session/logout") {
          res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessions.revoke(req.headers.cookie), "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (urlPath === "/api/service/control") {
          const result = await controlServiceRun(serviceRuns(), currentRepo, body);
          return sendJson(res, result.status, result.body);
        }

        if (urlPath === "/api/runtime/action") {
          if (runtimeAdminBusy) {
            return sendJson(res, 409, { ok: false, message: "Another runtime operation is already in progress." });
          }
          let action: RuntimeAdminAction;
          try {
            action = parseRuntimeAdminAction(body);
          } catch (error) {
            return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
          runtimeAdminBusy = true;
          try {
            const result = await runtimeAdmin.execute(action);
            return sendJson(res, 200, { ok: true, ...result });
          } finally {
            runtimeAdminBusy = false;
          }
        }

        if (urlPath === "/api/authoring-config") {
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          let config;
          try {
            config = validateAuthoringConfig(body);
          } catch (error) {
            return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
          const saved = saveAuthoringConfig(currentRepo, config);
          broadcast("snapshot", snapshotEvent());
          return sendJson(res, 200, { ok: true, config: saved, message: "Authoring models saved. Omitted stages inherit the runner default." });
        }
        if (urlPath === "/api/authoring-inventory/refresh") {
          return sendJson(res, 200, await consoleAuthoringInventory(currentRepo ?? undefined, body.runner, true, options.inventoryProbe));
        }
        if (urlPath === "/api/control") {
          const action = body.action as ControlAction;
          const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
          if (body.executor !== undefined && body.executor !== "worker" && body.executor !== "host") {
            return sendJson(res, 400, { ok: false, message: "executor must be 'worker' or 'host'." });
          }
          const executor = body.executor as Executor | undefined;
          // Only the re-derivation chain accepts a starting step; anything else
          // in `from` is ignored rather than rejected so an older client that
          // sends the field cannot break an unrelated action.
          const from = typeof body.from === "string" && REDERIVE_STEPS.includes(body.from as RederiveStepId)
            ? body.from as RederiveStepId
            : undefined;
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          if (action === "run" || action === "resume") {
            const repositoryId = await serviceRuns().repositoryId(currentRepo);
            if (!repositoryId) {
              return sendJson(res, 409, {
                ok: false,
                code: "service-required",
                message: `Register this repository with "forge-launcher runtime repo add ${currentRepo}", then restart the runtime. Legacy execution is retired.`,
              });
            }
            // An explicit host request is gated here so the operator learns
            // about a stopped runner or missing capability before a submission
            // is created. Clients that omit the field keep the older behaviour;
            // the service still fails closed for them.
            if (executor === "host") {
              const readiness = await runnerReadiness(currentRepo).catch(() => null);
              if (!readiness?.available) {
                return sendJson(res, 409, {
                  ok: false,
                  code: "host-runner-unavailable",
                  message: readiness?.blocker ??
                    "Host execution is unavailable until the local runtime reports a ready host runner.",
                });
              }
            }
          }
          if (action === "feature-increment-continue" && !featureIncrementHandoffHasChange(currentRepo)) {
            return sendJson(res, 200, { ok: false, message: "Add or change a feature in the interactive authoring session before continuing." });
          }
          // ADR-060: feature authoring is interactive, so the prompt is only
          // needed to pre-seed the session; the response names the session
          // rather than starting a background job.
          if (action === "feature-prd") {
            const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
            if (!prompt) return sendJson(res, 400, { ok: false, message: "prompt is required" });
            return sendJson(res, 200, controller.featurePrd());
          }
          if (action === "feature-increment") {
            const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
            if (!prompt) return sendJson(res, 400, { ok: false, message: "prompt is required" });
            return sendJson(res, 200, controller.featureIncrement());
          }
          if (action === "pause" || action === "stop" || action === "replay") {
            const routed = await routeServiceControl(serviceRuns(), currentRepo, action, taskId);
            return sendJson(res, routed.status, routed.body);
          }
          return sendJson(res, 200, controller.dispatch(action, taskId, from, executor));
        }
        if (urlPath === "/api/tasks/timeout") {
          const timeoutMs = Number(body.timeoutMs);
          if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            return sendJson(res, 400, { ok: false, message: "timeoutMs must be a positive integer (milliseconds)." });
          }
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const p = currentPaths()!;
          const taskId = typeof body.taskId === "string" && body.taskId.length > 0 ? body.taskId : undefined;
          let result;
          if (taskId) {
            result = repo.setTaskTimeout(p, taskId, timeoutMs);
          } else {
            result = repo.setAllTaskTimeouts(p, timeoutMs);
            if (result.ok) repo.setDefaultTimeout(p, timeoutMs);
          }
          if (result.ok) broadcast("snapshot", snapshotEvent());
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        if (urlPath === "/api/tasks/human-review") {
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
          const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim() : "";
          const notes = typeof body.notes === "string" ? body.notes.trim() : "";
          if (!taskId || !reviewer || !notes) return sendJson(res, 400, { ok: false, message: "taskId, reviewer, and review notes are required." });
          // Mirrors the engine's MIN_REVIEW_NOTES_LENGTH so a service approval is never sent with notes the record would refuse.
          if (notes.length < 40) return sendJson(res, 400, { ok: false, message: "Review notes must describe what was exercised and found (at least 40 characters)." });
          // Service runs record the approval as an acknowledged control from
          // the local operator; the run is already following, so no resume job.
          const routed = await routeServiceControl(serviceRuns(), currentRepo, "approve", taskId);
          if (!routed.body.ok) return sendJson(res, routed.status, { ...routed.body, resumed: false });
          let reviewRecord: string | undefined;
          let message = String(routed.body.message ?? "");
          try {
            reviewRecord = await writeServiceReviewRecord(currentRepo, taskId, reviewer, notes, routed.body);
          } catch (error) {
            message += ` The review record was not written: ${error instanceof Error ? error.message : String(error)}`;
          }
          broadcast("snapshot", snapshotEvent());
          return sendJson(res, routed.status, { ...routed.body, message, reviewRecord, resumed: false });
        }
        if (urlPath === "/api/projects/remove") {
          if (!body || !Array.isArray(body.paths) || body.paths.length === 0
            || !body.paths.every((entry): entry is string => typeof entry === "string" && entry.length > 0 && !entry.includes("\0"))) {
            return sendJson(res, 400, { ok: false, message: "paths must be a non-empty array of registered project paths." });
          }
          const results = removeProjects(body.paths, currentRepo);
          if (currentRepo && results.some((result) => result.status === "removed" && sameProjectPath(result.path, currentRepo!))) {
            currentRepo = null;
            controller.repoRoot = "";
            resetOffsets();
          }
          broadcast("snapshot", snapshotEvent());
          return sendJson(res, 200, { results, current: currentRepo });
        }
        if (urlPath === "/api/projects/select") {
          const target = String(body.path ?? "");
          if (!target || !fs.existsSync(target) || !fs.existsSync(path.join(target, "docs"))) {
            return sendJson(res, 400, { ok: false, message: "not a forge repo" });
          }
          currentRepo = path.resolve(target);
          controller.repoRoot = currentRepo;
          resetOffsets();
          upsertProject({ path: currentRepo });
          broadcast("snapshot", snapshotEvent());
          return sendJson(res, 200, { ok: true, repoRoot: currentRepo });
        }
        if (urlPath === "/api/projects/add") {
          const target = path.resolve(String(body.path ?? ""));
          if (!target || !looksLikeForgeRepo(target)) {
            return sendJson(res, 400, { ok: false, message: "not a forge repo" });
          }
          upsertProject({ path: target });
          return sendJson(res, 200, { ok: true });
        }
        if (urlPath === "/api/uploads") {
          const name = String(body.name ?? "");
          const content = String(body.content ?? "");
          if (!name || typeof content !== "string" || content.length === 0) {
            return sendJson(res, 400, { ok: false, message: "name and non-empty content are required." });
          }
          const staging = uploadStagingDir();
          fs.mkdirSync(staging, { recursive: true });
          const file = path.join(staging, sanitizeFileName(name));
          fs.writeFileSync(file, content, "utf8");
          return sendJson(res, 200, { ok: true, path: file, name: path.basename(file) });
        }
        if (urlPath === "/api/engine-config") {
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          if (typeof body.concurrency === "number") {
            if (!Number.isInteger(body.concurrency) || body.concurrency < 0) {
              return sendJson(res, 400, { ok: false, message: "concurrency must be a non-negative integer." });
            }
            const result = repo.setConcurrency(currentPaths()!, body.concurrency);
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          if (body.executionMode !== undefined) {
            if (body.executionMode !== "auto" && body.executionMode !== "manual") {
              return sendJson(res, 400, { ok: false, message: "executionMode must be 'auto' or 'manual'." });
            }
            const result = repo.setExecutionMode(currentPaths()!, body.executionMode);
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          if (body.selectedTaskIds !== undefined || body.selectionScope !== undefined) {
            const rawIds = Array.isArray(body.selectedTaskIds) ? body.selectedTaskIds : [];
            const selectedTaskIds = rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
            const selectionScope = body.selectionScope;
            if (selectionScope !== undefined && selectionScope !== null && !["single", "range", "list"].includes(String(selectionScope))) {
              return sendJson(res, 400, { ok: false, message: "selectionScope must be single, range, or list." });
            }
            const result = repo.setTaskSelection(currentPaths()!, selectionScope as "single" | "range" | "list" | null | undefined ?? null, selectedTaskIds);
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          if (body.logHarnessActivity !== undefined) {
            if (typeof body.logHarnessActivity !== "boolean") {
              return sendJson(res, 400, { ok: false, message: "logHarnessActivity must be a boolean." });
            }
            const result = repo.setLogHarnessActivity(currentPaths()!, body.logHarnessActivity);
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          if (body.hostExecution !== undefined) {
            if (typeof body.hostExecution !== "boolean") {
              return sendJson(res, 400, { ok: false, message: "hostExecution must be a boolean." });
            }
            if (body.hostExecution && body.confirmed !== true) {
              return sendJson(res, 400, { ok: false, message: "Enabling host execution requires explicit confirmation." });
            }
            const result = repo.setHostExecution(currentPaths()!, body.hostExecution);
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, result.ok ? 200 : 400, result);
          }
          const autoCommit = body.autoCommit;
          if (typeof autoCommit !== "boolean") {
            return sendJson(res, 400, { ok: false, message: "autoCommit must be a boolean." });
          }
          const result = repo.setAutoCommit(currentPaths()!, autoCommit);
          broadcast("snapshot", snapshotEvent());
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        if (urlPath === "/api/launch-cli") {
          if (!options.allowExternalOpen) return sendJson(res, 200, { ok: false, message: "launch-cli not enabled" });
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const { cli, args } = harnessCli(currentRepo);
          const launched = await launchCli(cli, currentRepo, args);
          const command = `cd "${currentRepo}" && ${cli} ${args.join(" ")}`.trim();
          return sendJson(res, 200, {
            ok: true,
            launched,
            cli,
            command,
            message: launched
              ? `${cli} launched in a new terminal (cwd: ${currentRepo}).`
              : `No supported terminal emulator found - run it manually: ${command}`,
          });
        }
        if (urlPath === "/api/authoring/session") {
          if (!options.allowExternalOpen) return sendJson(res, 200, { ok: false, message: "interactive sessions not enabled" });
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const target = typeof body.target === "string" ? body.target : "";
          const spec = AUTHORING_SESSIONS[target as AuthoringSessionTarget];
          if (!spec) return sendJson(res, 400, { ok: false, message: "target must be idea, prd, or feature-prd" });
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (target === "feature-prd" && !prompt) return sendJson(res, 400, { ok: false, message: "prompt is required" });
          const runner = selectedAuthoringRunner(currentRepo);
          if (runner === "stub") return sendJson(res, 400, { ok: false, message: "Interactive sessions are unavailable for the stub runner." });
          let model: string | undefined;
          try {
            model = (await resolveAuthoringModel(currentRepo, spec.stage, runner)).effectiveModel;
          } catch (error) {
            return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
          const message = spec.message(prompt);
          const args = interactiveAuthoringArgv(runner, message, model);
          if (target === "feature-prd") recordFeatureIncrementHandoff(currentRepo);
          const launched = await launchCli(runner, currentRepo, args);
          const command = `${runner} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
          return sendJson(res, 200, {
            ok: true,
            launched,
            cli: runner,
            command,
            message: launched
              ? `${runner} launched in a new terminal for interactive ${target} authoring.`
              : `No supported terminal emulator found - run it manually: cd "${currentRepo}" && ${command}`,
          });
        }
        if (urlPath === "/api/authoring/validate") {
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          try {
            const outputs = await validateAuthoredPrd(currentRepo);
            recordAuthoringStageSuccess(currentRepo, "prd", outputs, detectHarnessRoot(currentRepo) ?? ".agents");
            broadcast("snapshot", snapshotEvent());
            return sendJson(res, 200, { ok: true, message: `PRD validated (${outputs.length} output${outputs.length === 1 ? "" : "s"}).` });
          } catch (error) {
            return sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (urlPath === "/api/model-plan/override") {
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const agent = typeof body.agent === "string" ? body.agent : "";
          const primary = typeof body.primary === "string" && body.primary.trim() ? body.primary.trim() : undefined;
          const fallback = typeof body.fallback === "string" && body.fallback.trim() ? body.fallback.trim() : undefined;
          const result = repo.setModelOverride(currentPaths()!, agent, primary, fallback);
          if (result.ok) broadcast("snapshot", snapshotEvent());
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        if (urlPath === "/api/model-plan/terminal") {
          if (!options.allowExternalOpen) return sendJson(res, 200, { ok: false, message: "terminal launch not enabled" });
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const provider = body.provider === "copilot" ? "copilot"
            : body.provider === "opencode" ? "opencode"
            : body.provider === "claude" ? "claude" : "";
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!provider || !message || message.length > 10000) return sendJson(res, 400, { ok: false, message: "provider and a message up to 10000 characters are required" });
          const args = interactiveAuthoringArgv(provider, message);
          const launched = await launchCli(provider, currentRepo, args);
          const command = `${provider} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
          return sendJson(res, 200, { ok: true, launched, cli: provider, command, message: launched ? `${provider} launched in a new terminal.` : `Run manually: cd "${currentRepo}" && ${command}` });
        }
        if (urlPath === "/api/projects/create") {
          const req = body as unknown as CreateProjectRequest;
          if (!req.name || !req.idea) {
            return sendJson(res, 400, { ok: false, message: "name and idea are required" });
          }
          if (req.authoringConfig !== undefined) {
            try {
              req.authoringConfig = validateAuthoringConfig(req.authoringConfig);
            } catch (error) {
              return sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
            }
          }
          if (req.concurrency !== undefined) {
            if (typeof req.concurrency !== "number" || !Number.isInteger(req.concurrency) || req.concurrency <= 0) {
              return sendJson(res, 400, { ok: false, message: "concurrency must be a positive integer." });
            }
          }
          if (req.prdPath && !resolveInputFile(req.prdPath).ok) {
            return sendJson(res, 400, { ok: false, message: `PRD file not found: ${req.prdPath}` });
          }
          for (const p of req.researchPaths ?? []) {
            if (!resolveInputFile(p).ok) {
              return sendJson(res, 400, { ok: false, message: `Research/seed file not found: ${p}` });
            }
          }
          const result = controller.createProject(req);
          return sendJson(res, 200, result);
        }
        if (urlPath === "/api/projects/bootstrap") {
          const requestedPath = typeof body.path === "string" ? body.path.trim() : "";
          if (!requestedPath) return sendJson(res, 400, { ok: false, message: "repository path is required" });
          const target = path.resolve(requestedPath);
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return sendJson(res, 400, { ok: false, message: "directory not found" });
          const harness = typeof body.harness === "string" ? body.harness : undefined;
          if (harness !== undefined && !["agents", "github", "claude", "opencode"].includes(harness)) {
            return sendJson(res, 400, { ok: false, message: "harness must be agents, github, claude, or opencode" });
          }
          // `inherit` is never sent: the client omits the field instead, so any
          // value that arrives here has to name a runner the launcher accepts.
          const runner = typeof body.runner === "string" ? body.runner.trim() : undefined;
          if (runner !== undefined && !isRunnerChoice(runner)) {
            return sendJson(res, 400, { ok: false, message: "runner must be copilot, opencode, or claude" });
          }
          try {
            const result = controller.bootstrap({ path: target, harness, force: body.force === true, initGit: body.initGit === true, runner });
            return sendJson(res, result.ok ? 200 : 400, result);
          } catch (err) {
            return sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : "failed to start bootstrap" });
          }
        }
        if (urlPath === "/api/open") {
          if (!options.allowExternalOpen) return sendJson(res, 200, { ok: false, message: "open not enabled" });
          const target = String(body.path ?? "");
          if (!currentRepo) return sendJson(res, 400, { ok: false, message: "no repo selected" });
          const p = currentPaths()!;
          const abs = repo.resolveWithin(p.repoRoot, target);
          if (!abs) return sendJson(res, 400, { ok: false, message: "invalid path" });
          openPath(abs);
          return sendJson(res, 200, { ok: true });
        }
        return sendText(res, 404, "not found");
      }

      // Static: console client + board
      if (method === "GET") {
        if (urlPath === "/") {
          const idx = fs.readFileSync(path.join(clientDir, "index.html"), "utf8")
            .replace(/__FORGE_TOKEN__/g, token);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(idx);
          return;
        }
        if (urlPath === "/board") {
          const idx = fs.readFileSync(path.join(boardAssets, "index.html"), "utf8")
            .replace('href="/style.css"', 'href="/board/style.css"')
            .replace('src="/vendor/pixi.min.js"', 'src="/board/vendor/pixi.min.js"')
            .replace('src="/app.js"', 'src="/board/app.js"');
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(idx);
          return;
        }
        if (urlPath.startsWith("/board/")) {
          const file = readStatic(boardAssets, urlPath.slice("/board/".length));
          if (file) {
            res.writeHead(200, { "Content-Type": file.type });
            res.end(file.body);
            return;
          }
          return sendText(res, 404, "not found");
        }
        const file = readStatic(clientDir, urlPath);
        if (file) {
          res.writeHead(200, { "Content-Type": file.type });
          res.end(file.body);
          return;
        }
      }

      sendText(res, 404, "not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      // Name the route: a bare 500 with a message the client never reads is not
      // diagnosable once the request has gone.
      onLog(`console ${res.statusCode === 200 ? "handler" : "error"} ${urlPath}: ${message}`);
      if (!res.headersSent) {
        if (urlPath.startsWith("/api/")) sendJson(res, 500, { ok: false, message });
        else sendText(res, 500, message);
      } else {
        // The response is already on the wire; writing again would throw inside
        // the catch and take the server down. End the socket instead.
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  onLog(`  forge console: ${url}`);

  if (options.repoRoot && looksLikeForgeRepo(options.repoRoot)) {
    upsertProject({ path: options.repoRoot });
  }

  if (options.open) openBrowser(sessions.issueSignInUrl());

  return {
    url,
    port,
    token,
    signInUrl: () => sessions.issueSignInUrl(),
    selectRepo(repoRoot: string) {
      currentRepo = path.resolve(repoRoot);
      controller.repoRoot = currentRepo;
      resetOffsets();
      upsertProject({ path: currentRepo });
      broadcast("snapshot", snapshotEvent());
    },
    stop() {
      return new Promise<void>((resolve) => {
        clearInterval(poller);
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
