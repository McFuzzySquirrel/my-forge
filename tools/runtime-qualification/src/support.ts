import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LAUNCHER_DIR = path.join(REPO_ROOT, "scripts", "forge-launcher");
const TSX_LOADER = path.join(LAUNCHER_DIR, "node_modules", "tsx", "dist", "loader.mjs");
const LAUNCHER_CLI = path.join(LAUNCHER_DIR, "scripts", "cli.ts");
const OPERATOR_PROJECT = "myforge-runtime";

export interface Isolation {
  readonly root: string;
  readonly runtimeDir: string;
  readonly project: string;
  readonly apiPort: number;
}

/**
 * Points every launcher call at an isolated installation. The operator's
 * project, data directory, and API port are refused so qualification can never
 * stop, reset, or restore the operator's runtime.
 */
export function isolate(root: string, project = "myforge-qual", apiPort = 18483): Isolation {
  if (project === OPERATOR_PROJECT) throw new Error(`Refusing to qualify against the operator project '${OPERATOR_PROJECT}'.`);
  if (apiPort === 8483) throw new Error("Refusing to use the operator API port 8483.");
  if (!path.isAbsolute(root)) throw new Error("The qualification root must be an absolute path.");
  const isolation = { root, runtimeDir: path.join(root, "runtime"), project, apiPort };
  mkdirSync(isolation.runtimeDir, { recursive: true });
  process.env.MYFORGE_RUNTIME_DIR = isolation.runtimeDir;
  process.env.MYFORGE_RUNTIME_PROJECT = project;
  process.env.MYFORGE_API_PORT = String(apiPort);
  return isolation;
}

export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Runs the launcher CLI from source against the isolated installation. */
export function launcher(args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number } = {}): Promise<CommandOutput> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, LAUNCHER_CLI, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started });
    });
  });
}

export async function requireLauncher(args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number } = {}): Promise<CommandOutput> {
  const result = await launcher(args, options);
  if (result.code !== 0) {
    throw new Error(`forge-launcher ${args.join(" ")} exited ${result.code}\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  }
  return result;
}

export function tail(text: string, lines = 15): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

export function run(command: string, args: readonly string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function must(command: string, args: readonly string[], cwd?: string): string {
  const result = run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function containerName(isolation: Isolation, service: string): string {
  return `${isolation.project}_${service}_1`;
}

export function podman(args: readonly string[]): string {
  return must("podman", args);
}

export function containerState(isolation: Isolation, service: string): string {
  return run("podman", ["inspect", "--format", "{{.State.Status}}", containerName(isolation, service)]).stdout.trim();
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${detail}`);
    }
    await sleep(intervalMs);
  }
}

export interface Evidence {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly details: Record<string, unknown>;
  readonly error?: string;
}

/** Collects scenario outcomes; a failure is recorded and the suite continues. */
export class Report {
  readonly entries: Evidence[] = [];
  constructor(readonly suite: string, readonly environment: Record<string, unknown>) {}

  async scenario(id: string, title: string, body: (details: Record<string, unknown>) => Promise<void>): Promise<boolean> {
    const details: Record<string, unknown> = {};
    const started = Date.now();
    process.stdout.write(`\n[${id}] ${title}\n`);
    try {
      await body(details);
      this.entries.push({ id, title, passed: true, durationMs: Date.now() - started, details });
      process.stdout.write(`[${id}] PASS (${Math.round((Date.now() - started) / 1000)} s) ${JSON.stringify(details)}\n`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.entries.push({ id, title, passed: false, durationMs: Date.now() - started, details, error: message });
      process.stdout.write(`[${id}] FAIL ${message}\n${JSON.stringify(details)}\n`);
      return false;
    }
  }

  get passed(): boolean {
    return this.entries.length > 0 && this.entries.every((entry) => entry.passed);
  }

  write(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      suite: this.suite,
      generatedAt: new Date().toISOString(),
      environment: this.environment,
      passed: this.passed,
      scenarios: this.entries,
    }, null, 2)}\n`);
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function hostEnvironment(): Record<string, unknown> {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    kernel: run("uname", ["-r"]).stdout.trim(),
    podman: run("podman", ["--version"]).stdout.trim(),
    rootless: run("podman", ["info", "--format", "{{.Host.Security.Rootless}}"]).stdout.trim() === "true",
    gitHead: run("git", ["rev-parse", "--short", "HEAD"], REPO_ROOT).stdout.trim(),
  };
}
