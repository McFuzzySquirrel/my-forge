import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveResources } from "./resources.ts";
import { podmanUnavailableMessage, remediationHints, withRemediation } from "./runtime-diagnostics.ts";
import {
  listRegisteredRepositories,
  registerRepository,
  unregisterRepository,
  writeRepositoryOverride,
  type RegisteredRepository,
} from "./runtime-repositories.ts";
import {
  ensureHarnessGrants,
  grantHarnessCredential,
  harnessCli,
  HARNESS_CREDENTIAL_VARIABLES,
  listHarnessGrants,
  revokeHarnessCredential,
} from "./runtime-harnesses.ts";
import {
  ensureHostRunnerFiles,
  getHostRunnerProcessStatus,
  listEnabledHostRunnerRepositories,
  startHostRunner,
  stopHostRunner,
  updateHostRunnerCapability,
} from "./runtime-host-runner.ts";

const CREDENTIALS_FILE = "runtime.env";
const APPLIED_REPOSITORIES_FILE = "runtime-applied-repositories.json";
const LEGACY_KEYS = ["POSTGRES_SUPERUSER_PASSWORD", "DAPR_DB_PASSWORD", "APP_DB_PASSWORD"] as const;
// Later secrets are appended in order, so an older installation holds a prefix of KEYS.
const KEYS = [...LEGACY_KEYS, "MYFORGE_API_TOKEN", "DAPR_API_TOKEN"] as const;
const ROTATABLE_KEYS = ["MYFORGE_API_TOKEN", "DAPR_API_TOKEN"] as const;
export const DEFAULT_API_PORT = 8483;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

type RuntimeAction = "start" | "status" | "stop" | "reset";
type RuntimeBackupAction = "backup" | "restore";
const RUNTIME_VOLUMES = ["postgres_data", "scheduler_data", "runtime_data"] as const;
export const DEFAULT_RUNTIME_PROJECT = "myforge-runtime";
const RUNTIME_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BACKUP_FILE = "manifest.json";
const BACKUP_VERSION = 1;

interface RuntimeOptions {
  readonly hostTools: boolean;
  readonly postgresPort?: number;
  readonly confirm: boolean;
  readonly backupPath?: string;
  readonly allowGitDrift?: boolean;
}

export interface RuntimeBackupManifestV1 {
  readonly version: 1;
  readonly createdAt: string;
  readonly volumes: readonly {
    readonly name: (typeof RUNTIME_VOLUMES)[number];
    readonly file: string;
    readonly sha256: string;
  }[];
  /**
   * Fingerprint of the database credentials the restored PostgreSQL data was
   * initialized with. Absent in backups created before it was recorded.
   */
  readonly databaseCredentialFingerprint?: string;
  /**
   * Forge integration branch tips of each registered repository at backup
   * time. Git is not copied; restore checks that Git still matches the stores.
   */
  readonly repositories?: readonly BackupRepositoryRefs[];
}

interface BackupRepositoryRefs {
  readonly id: string;
  readonly path: string;
  readonly refs: Readonly<Record<string, string>>;
}

const FORGE_REFS = "refs/heads/forge/";

export interface RuntimeEnvironment {
  readonly file: string;
  readonly values: Readonly<Record<(typeof KEYS)[number], string>>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Compose project that owns the runtime's containers and volumes. An override
 * (MYFORGE_RUNTIME_PROJECT) isolates a second installation, such as a
 * qualification stack, that also sets its own data directory and API port.
 */
export function getRuntimeProject(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MYFORGE_RUNTIME_PROJECT;
  if (value === undefined || value === "") return DEFAULT_RUNTIME_PROJECT;
  if (!RUNTIME_PROJECT_PATTERN.test(value)) {
    throw new Error("MYFORGE_RUNTIME_PROJECT must be 1-63 lowercase letters, digits, '-' or '_', starting with a letter or digit.");
  }
  return value;
}

export function getRuntimeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  // Host-side override for an isolated installation. Unlike XDG_DATA_HOME it
  // does not relocate Podman's own rootless storage.
  if (env.MYFORGE_RUNTIME_DIR) {
    if (!pathApi.isAbsolute(env.MYFORGE_RUNTIME_DIR)) {
      throw new Error("MYFORGE_RUNTIME_DIR must be an absolute path.");
    }
    return pathApi.normalize(env.MYFORGE_RUNTIME_DIR);
  }
  let base: string;
  if (platform === "win32") {
    base = env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local");
  } else if (platform === "darwin") {
    base = pathApi.join(home, "Library", "Application Support");
  } else {
    base = env.XDG_DATA_HOME || pathApi.join(home, ".local", "share");
  }
  return pathApi.join(base, "MyForge", "runtime");
}

export async function readRuntimeEnvironment(directory: string): Promise<RuntimeEnvironment> {
  const file = path.join(directory, CREDENTIALS_FILE);
  for (let attempt = 0; attempt < 20; attempt++) {
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime credentials must be a regular file: ${file}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Runtime credentials are not owned by the current user: ${file}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      await chmod(file, 0o600);
    }
    const contents = await readFile(file, "utf8");
    const entries = new Map<string, string>();
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Runtime credentials are malformed: ${file}. Restore it from your own copy; backups do not include it (see docs/forge-launcher.md#runtime-troubleshooting).`);
      const key = line.slice(0, separator);
      if (entries.has(key)) throw new Error(`Runtime credentials contain a duplicate setting: ${key}. Restore it from your own copy; backups do not include it (see docs/forge-launcher.md#runtime-troubleshooting).`);
      entries.set(key, line.slice(separator + 1));
    }
    const values = {} as Record<(typeof KEYS)[number], string>;
    // Only secrets belong here: podman-compose lets env-file values override
    // the process environment, so a stored setting would pin options like the host port.
    let valid = entries.size === KEYS.length;
    for (const key of KEYS) {
      const value = entries.get(key);
      if (!value || !/^[0-9a-f]{64}$/.test(value)) {
        valid = false;
        break;
      }
      values[key] = value;
    }
    if (valid) {
      return { file, values };
    }
    if (attempt < 19) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    throw new Error(`Runtime credentials are invalid; refusing to replace them: ${file}. Restore it from your own copy; backups do not include it (see docs/forge-launcher.md#runtime-troubleshooting).`);
  }
  throw new Error(`Timed out reading runtime credentials: ${file}`);
}

/**
 * Older installations hold a prefix of KEYS; append the missing generated
 * secrets once, atomically, without touching the existing ones.
 */
async function upgradeLegacyCredentials(file: string): Promise<void> {
  let contents: string;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    contents = await readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const legacy = lines.length >= LEGACY_KEYS.length && lines.length < KEYS.length
    && lines.every((line, index) => new RegExp(`^${KEYS[index]}=[0-9a-f]{64}$`).test(line));
  if (!legacy) return;
  const added = KEYS.slice(lines.length).map((key) => `${key}=${randomBytes(32).toString("hex")}`);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${[...lines, ...added].join("\n")}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
}

/** Bearer token and loopback port of the local service API. */
export async function readRuntimeApiAccess(
  directory = getRuntimeDataDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly token: string; readonly baseUrl: string }> {
  const environment = await requireRuntimeEnvironment(directory);
  const port = env.MYFORGE_API_PORT ? Number(env.MYFORGE_API_PORT) : DEFAULT_API_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MYFORGE_API_PORT must be from 1 to 65535.");
  return { token: environment.values.MYFORGE_API_TOKEN, baseUrl: `http://127.0.0.1:${port}` };
}

async function requireRuntimeEnvironment(directory = getRuntimeDataDir()): Promise<RuntimeEnvironment> {
  const file = path.join(directory, CREDENTIALS_FILE);
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Local runtime is not initialized; run "forge-launcher runtime start" first.`);
    }
    throw error;
  }
  await upgradeLegacyCredentials(file);
  return readRuntimeEnvironment(directory);
}

/**
 * Replaces the service API and Dapr sidecar tokens. The database passwords are
 * kept because they are baked into the database roles.
 */
export async function rotateRuntimeTokens(directory = getRuntimeDataDir()): Promise<void> {
  const environment = await requireRuntimeEnvironment(directory);
  const rotated: Record<string, string> = { ...environment.values };
  for (const key of ROTATABLE_KEYS) rotated[key] = randomBytes(32).toString("hex");
  const temporary = `${environment.file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${KEYS.map((key) => `${key}=${rotated[key]}`).join("\n")}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, environment.file);
}

export async function ensureRuntimeCredentials(directory = getRuntimeDataDir()): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Runtime data path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error(`Runtime data directory is not owned by the current user: ${directory}`);
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const file = path.join(directory, CREDENTIALS_FILE);
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      const lines = KEYS.map((key) => `${key}=${randomBytes(32).toString("hex")}`);
      await handle.writeFile(`${lines.join("\n")}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(file).catch(() => undefined);
      throw error;
    }
    await handle.close();
    if (process.platform !== "win32") await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await upgradeLegacyCredentials(file);
  }
  return (await readRuntimeEnvironment(directory)).file;
}

function parseOptions(action: RuntimeAction | RuntimeBackupAction, args: readonly string[]): RuntimeOptions {
  const options: { hostTools: boolean; postgresPort?: number; confirm: boolean; backupPath?: string; allowGitDrift?: boolean } = {
    hostTools: false,
    confirm: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--host-tools" && action === "start") {
      options.hostTools = true;
    } else if (argument === "--postgres-port" && action === "start") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error("--postgres-port requires a number from 1 to 65535.");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--postgres-port must be from 1 to 65535.");
      }
      options.postgresPort = port;
    } else if (argument === "--confirm" && (action === "reset" || action === "restore")) {
      options.confirm = true;
    } else if (argument === "--allow-git-drift" && action === "restore") {
      options.allowGitDrift = true;
    } else if ((argument === "--output" && action === "backup") || (argument === "--from" && action === "restore")) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a directory path.`);
      options.backupPath = path.resolve(value);
    } else {
      throw new Error(`Unknown runtime option: ${argument}`);
    }
  }
  if (options.postgresPort !== undefined && !options.hostTools) {
    throw new Error("--postgres-port requires --host-tools.");
  }
  if ((action === "backup" || action === "restore") && !options.backupPath) {
    throw new Error(`runtime ${action} requires ${action === "backup" ? "--output" : "--from"} <directory>.`);
  }
  if (action === "restore" && !options.confirm) {
    throw new Error("Runtime restore replaces all persistent runtime volumes; rerun with --confirm.");
  }
  return options;
}

function runCommand(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function ensureRootlessPodman(): Promise<void> {
  let result: CommandResult;
  try {
    result = await runCommand("podman", ["info", "--format", "json"]);
  } catch {
    throw new Error(podmanUnavailableMessage("missing"));
  }
  if (result.code !== 0) {
    throw new Error(podmanUnavailableMessage("unreachable", process.platform, result.stderr.trim().split(/\r?\n/).slice(-5).join("\n")));
  }
  let info: { host?: { security?: { rootless?: boolean } } };
  try {
    info = JSON.parse(result.stdout) as { host?: { security?: { rootless?: boolean } } };
  } catch {
    throw new Error("Podman returned invalid runtime information.");
  }
  if (info.host?.security?.rootless !== true) throw new Error(podmanUnavailableMessage("not-rootless"));
  const composeCheck = await runCommand("podman", ["compose", "version"]).catch(() => undefined);
  if (!composeCheck || composeCheck.code !== 0) {
    const details = composeCheck ? `${composeCheck.stderr}${composeCheck.stdout}`.trim().split(/\r?\n/).slice(-3).join("\n") : "";
    throw new Error(podmanUnavailableMessage("no-compose", process.platform, details));
  }
}

export async function assertHostPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      reject(new Error(
        `PostgreSQL host port ${port} is unavailable (${error.message}); stop the service using it or choose another --postgres-port.`,
      ));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

const SERVICES = ["postgres", "placement", "scheduler", "daprd", "forge"] as const;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;

export interface RuntimeContainer {
  readonly name: string;
  readonly service: string;
  readonly state: string;
  readonly health?: string;
}

export interface RuntimeAdminState {
  readonly project: string;
  readonly initialized: boolean;
  readonly status: "not-initialized" | "stopped" | "running" | "degraded";
  readonly containers: readonly RuntimeContainer[];
  readonly missingServices: readonly string[];
  readonly diagnostics: readonly string[];
  readonly repositories: readonly RegisteredRepository[];
  readonly hostRunnerEnabledRepositoryIds: readonly string[];
  readonly hostRunnerStatus: "disabled" | "running" | "stopped";
  /** Variable names only. Credential values are never exposed by this API. */
  readonly harnessGrants: Readonly<Record<string, readonly string[]>>;
  readonly startOptions: { readonly hostTools: boolean; readonly postgresPort?: number } | null;
  readonly restartRequired: boolean;
}

export type RuntimeAdminAction =
  | { readonly action: "start"; readonly hostTools: boolean; readonly postgresPort?: number }
  | { readonly action: "stop"; readonly confirmed: boolean }
  | { readonly action: "restart"; readonly confirmed: boolean; readonly hostTools: boolean; readonly postgresPort?: number }
  | { readonly action: "reset"; readonly confirmed: boolean }
  | { readonly action: "backup"; readonly output: string }
  | { readonly action: "restore"; readonly from: string; readonly confirmed: boolean; readonly allowGitDrift: boolean }
  | { readonly action: "rotate-tokens"; readonly confirmed: boolean }
  | { readonly action: "runner-capability"; readonly id: string; readonly operation: "enable" | "rotate" | "revoke"; readonly confirmed: boolean }
  | { readonly action: "repo-add"; readonly path: string; readonly id?: string }
  | { readonly action: "repo-remove"; readonly id: string; readonly confirmed: boolean }
  | { readonly action: "harness-grant"; readonly harness: string; readonly variable: string; readonly value: string }
  | { readonly action: "harness-revoke"; readonly harness: string; readonly variable?: string; readonly confirmed: boolean };

export interface RuntimeAdminResult {
  readonly message: string;
  readonly restartRequired: boolean;
}

/** Returns the services that are missing or not running; empty when all are up. */
export function unreadyServices(containers: readonly RuntimeContainer[]): string[] {
  return SERVICES.filter((service) => !containers.some((container) =>
    container.service === service &&
    container.state === "running" &&
    (service !== "forge" || container.health === "healthy")
  ));
}

async function listRuntimeContainers(): Promise<RuntimeContainer[]> {
  const result = await runCommand("podman", [
    "ps", "-a", "--filter", `label=com.docker.compose.project=${getRuntimeProject()}`, "--format", "json",
  ]);
  if (result.code !== 0) throw new Error("Unable to list local runtime containers with Podman.");
  const entries = JSON.parse(result.stdout || "[]") as Array<{
    Names?: string[]; State?: string; Health?: string; Status?: string; Labels?: Record<string, string>;
  }>;
  return entries.map((entry) => ({
    name: entry.Names?.[0] ?? "",
    service: entry.Labels?.["com.docker.compose.service"] ?? "",
    state: entry.State ?? "unknown",
    ...((entry.Health ?? entry.Status?.match(/\((healthy|unhealthy|starting)\)$/)?.[1])
      ? { health: entry.Health ?? entry.Status?.match(/\((healthy|unhealthy|starting)\)$/)?.[1] }
      : {}),
  }));
}

// podman-compose can exit 0 when a container fails to start (for example, a
// host port conflict), so confirm every service is running and PostgreSQL accepts connections.
async function waitForRuntimeReady(environment: RuntimeEnvironment): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let containers: RuntimeContainer[] = [];
  let pending: string[] = [...SERVICES];
  while (Date.now() < deadline) {
    containers = await listRuntimeContainers();
    pending = unreadyServices(containers);
    if (pending.length === 0) {
      const postgres = containers.find((container) => container.service === "postgres")!;
      const probe = await runCommand("podman", ["exec", postgres.name, "pg_isready", "-U", "postgres", "-d", "postgres"]);
      if (probe.code === 0) return;
      pending = ["postgres (not accepting connections)"];
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  const details = await runtimeDiagnostics(containers, environment.values);
  throw new Error(withRemediation(
    `Local runtime did not become ready: ${pending.join(", ")}.` +
    `${details.length ? `\n${details.join("\n")}` : ""}\n` +
    `Run "forge-launcher runtime status" to inspect it and "forge-launcher runtime stop" to stop it.`,
    details.join("\n"),
  ));
}

function redact(output: string, values: RuntimeEnvironment["values"]): string {
  let safe = output;
  for (const secret of Object.values(values)) {
    if (secret.length > 0) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/(password=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:POSTGRES|DAPR|APP)_DB_PASSWORD|POSTGRES_SUPERUSER_PASSWORD|MYFORGE_API_TOKEN|DAPR_API_TOKEN)=([^\s]+)/g, "$1=[REDACTED]");
}

async function runtimeDiagnostics(
  containers: readonly RuntimeContainer[],
  values: RuntimeEnvironment["values"],
): Promise<string[]> {
  const details: string[] = [];
  for (const container of containers.filter((entry) =>
    entry.state !== "running" || (entry.service === "forge" && entry.health !== "healthy")
  )) {
    const logs = await runCommand("podman", ["logs", "--tail", "10", container.name]).catch(() => undefined);
    const text = logs ? redact(`${logs.stdout}${logs.stderr}`, values).trim() : "";
    details.push(`${container.service}: ${container.state}${text ? `\n${text}` : ""}`);
  }
  return details;
}

interface AppliedRuntimeState {
  readonly version: 1;
  readonly repositories: readonly RegisteredRepository[];
  readonly restartRequired?: boolean;
  readonly hostTools?: boolean;
  readonly postgresPort?: number;
}

async function readAppliedRuntimeState(dataDir: string): Promise<AppliedRuntimeState | null> {
  const file = path.join(dataDir, APPLIED_REPOSITORIES_FILE);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Applied runtime repository state must be a regular file: ${file}`);
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<AppliedRuntimeState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.repositories) || !parsed.repositories.every((entry) =>
    entry && typeof entry.id === "string" && typeof entry.path === "string" && path.isAbsolute(entry.path)) ||
    (parsed.restartRequired !== undefined && typeof parsed.restartRequired !== "boolean") ||
    (parsed.hostTools !== undefined && typeof parsed.hostTools !== "boolean") ||
    (parsed.postgresPort !== undefined &&
      (typeof parsed.postgresPort !== "number" || !Number.isInteger(parsed.postgresPort) || parsed.postgresPort < 1 || parsed.postgresPort > 65535))) {
    throw new Error(`Applied runtime repository state is invalid: ${file}`);
  }
  return parsed as AppliedRuntimeState;
}

async function recordAppliedRepositories(dataDir: string, options: RuntimeOptions): Promise<void> {
  const file = path.join(dataDir, APPLIED_REPOSITORIES_FILE);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const repositories = await listRegisteredRepositories(dataDir);
  const startOptions = {
    hostTools: options.hostTools,
    ...(options.postgresPort !== undefined ? { postgresPort: options.postgresPort } : {}),
  };
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, repositories, restartRequired: false, ...startOptions }, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
}

async function markRuntimeRestartRequired(dataDir: string): Promise<void> {
  const file = path.join(dataDir, APPLIED_REPOSITORIES_FILE);
  const current = await readAppliedRuntimeState(dataDir);
  const repositories = current?.repositories ?? await listRegisteredRepositories(dataDir);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      version: 1,
      repositories,
      restartRequired: true,
      ...(current?.hostTools !== undefined ? { hostTools: current.hostTools } : {}),
      ...(current?.postgresPort !== undefined ? { postgresPort: current.postgresPort } : {}),
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
}

async function repositoryRestartRequired(
  repositories: readonly RegisteredRepository[],
  runtimeRunning: boolean,
  applied: AppliedRuntimeState | null,
): Promise<boolean> {
  if (!runtimeRunning) return false;
  if (!applied) return repositories.length > 0;
  const sort = (entries: readonly RegisteredRepository[]) =>
    [...entries].sort((left, right) => left.id.localeCompare(right.id));
  return applied.restartRequired === true ||
    JSON.stringify(sort(repositories)) !== JSON.stringify(sort(applied.repositories));
}

export async function getRuntimeAdminState(dataDir = getRuntimeDataDir()): Promise<RuntimeAdminState> {
  const project = getRuntimeProject();
  const [repositories, harnessGrants, hostRunnerEnabledRepositoryIds, hostRunnerStatus] = await Promise.all([
    listRegisteredRepositories(dataDir),
    listHarnessGrants(dataDir),
    listEnabledHostRunnerRepositories(dataDir),
    getHostRunnerProcessStatus(dataDir),
  ]);
  let credentialsPresent = false;
  try {
    await lstat(path.join(dataDir, CREDENTIALS_FILE));
    credentialsPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!credentialsPresent) {
    return {
      project,
      initialized: false,
      status: "not-initialized",
      containers: [],
      missingServices: [...SERVICES],
      diagnostics: [],
      repositories,
      hostRunnerEnabledRepositoryIds,
      hostRunnerStatus,
      harnessGrants,
      startOptions: null,
      restartRequired: false,
    };
  }

  const environment = await readRuntimeEnvironment(dataDir);
  await ensureRootlessPodman();
  const containers = await listRuntimeContainers();
  const missingServices = unreadyServices(containers);
  const running = containers.some((container) => container.state === "running");
  const diagnostics = await runtimeDiagnostics(containers, environment.values);
  const applied = await readAppliedRuntimeState(dataDir);
  return {
    project,
    initialized: true,
    status: missingServices.length === 0 ? "running" : running ? "degraded" : "stopped",
    containers,
    missingServices,
    diagnostics,
    repositories,
    hostRunnerEnabledRepositoryIds,
    hostRunnerStatus,
    harnessGrants,
    startOptions: applied?.hostTools === undefined
      ? null
      : {
        hostTools: applied.hostTools,
        ...(applied.postgresPort !== undefined ? { postgresPort: applied.postgresPort } : {}),
      },
    restartRequired: await repositoryRestartRequired(repositories, running, applied),
  };
}

/**
 * Per-project host-runner availability for run-time gating.
 *
 * Deliberately narrower than `getRuntimeAdminState`: it reads only the
 * repository registry, host-runner capabilities, and the runner process, so a
 * caller polling it while a run is live does not shell out to Podman.
 */
export interface HostRunnerReadiness {
  readonly repositoryId: string | null;
  readonly registered: boolean;
  readonly capabilityEnabled: boolean;
  readonly hostRunnerStatus: "disabled" | "running" | "stopped";
  readonly available: boolean;
  /** Operator-facing cause when `available` is false. */
  readonly blocker: string | null;
}

async function sameRepositoryPath(left: string, right: string): Promise<boolean> {
  const normalise = async (value: string): Promise<string> => {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  return await normalise(left) === await normalise(right);
}

export async function getHostRunnerReadiness(
  repoRoot: string,
  dataDir = getRuntimeDataDir(),
): Promise<HostRunnerReadiness> {
  const [repositories, enabledRepositoryIds, hostRunnerStatus] = await Promise.all([
    listRegisteredRepositories(dataDir),
    listEnabledHostRunnerRepositories(dataDir),
    getHostRunnerProcessStatus(dataDir),
  ]);
  let registered: RegisteredRepository | null = null;
  for (const candidate of repositories) {
    if (await sameRepositoryPath(candidate.path, repoRoot)) {
      registered = candidate;
      break;
    }
  }
  const capabilityEnabled = registered !== null && enabledRepositoryIds.includes(registered.id);
  const blocker = registered === null
    ? "Register this project with the local runtime before using host execution."
    : !capabilityEnabled
      ? "Enable this project's host-runner capability, then restart the runtime."
      : hostRunnerStatus !== "running"
        ? "The native host runner is not running. Start the local runtime to use host execution."
        : null;
  return {
    repositoryId: registered?.id ?? null,
    registered: registered !== null,
    capabilityEnabled,
    hostRunnerStatus,
    available: blocker === null,
    blocker,
  };
}

async function compose(
  action: "up" | "ps" | "down",
  options: RuntimeOptions,
  environment: RuntimeEnvironment,
): Promise<string> {
  const { deploymentDir, executionDir, templatesDir } = resolveResources();
  const engineDir = path.dirname(executionDir);
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const launcherNodeModules = path.join(packageDir, "node_modules");
  if (action === "up") {
    await mkdir(path.join(engineDir, "node_modules"), { recursive: true });
  }
  const baseFile = path.join(deploymentDir, "compose.yaml");
  const args = ["compose", "-p", getRuntimeProject(), "--env-file", environment.file, "-f", baseFile];
  if (action === "up" && options.hostTools) {
    args.push("-f", path.join(deploymentDir, "compose.host-tools.yaml"));
  }
  const repositoryOverride = await writeRepositoryOverride(path.dirname(environment.file));
  if (repositoryOverride) args.push("-f", repositoryOverride);
  args.push(action);
  if (action === "up") args.push("-d");
  if (action === "down" && options.confirm) args.push("-v");
  const env = { ...process.env };
  delete env.POSTGRES_SUPERUSER_PASSWORD;
  delete env.DAPR_DB_PASSWORD;
  delete env.APP_DB_PASSWORD;
  delete env.MYFORGE_API_TOKEN;
  delete env.DAPR_API_TOKEN;
  env.MYFORGE_ENGINE_DIR = engineDir;
  env.MYFORGE_LAUNCHER_NODE_MODULES = launcherNodeModules;
  env.MYFORGE_TEMPLATES_DIR = templatesDir;
  env.MYFORGE_HARNESS_GRANTS_DIR = await ensureHarnessGrants(path.dirname(environment.file));
  const hostRunnerFiles = await ensureHostRunnerFiles(path.dirname(environment.file));
  env.MYFORGE_HOST_RUNNER_HASHES_FILE = hostRunnerFiles.hashesFile;
  if (action === "up" && options.hostTools) {
    env.POSTGRES_PORT = String(options.postgresPort ?? 55432);
  }
  const result = await runCommand("podman", args, env);
  const output = redact(`${result.stdout}${result.stderr}`, environment.values).trim();
  if (result.code !== 0) {
    const details = output.split(/\r?\n/).slice(-20).join("\n");
    throw new Error(withRemediation(`Podman Compose ${action} failed (exit ${result.code}).${details ? `\n${details}` : ""}`, output));
  }
  return output;
}

async function startManagedHostRunner(dataDir: string): Promise<void> {
  const credentials = await readRuntimeApiAccess(dataDir);
  const { executionDir } = resolveResources();
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = Number(new URL(credentials.baseUrl).port);
  await startHostRunner(dataDir, credentials.token, port, path.dirname(executionDir), packageDir);
}

const RUNTIME_USAGE = `Usage:
  forge-launcher runtime start [--host-tools] [--postgres-port <n>]
  forge-launcher runtime status
  forge-launcher runtime stop
  forge-launcher runtime reset --confirm
  forge-launcher runtime backup --output <new-directory>
  forge-launcher runtime restore --from <backup-directory> --confirm [--allow-git-drift]
  forge-launcher runtime repo add <repository> [--id <id>]
  forge-launcher runtime repo list
  forge-launcher runtime repo remove <id>
  forge-launcher runtime runner <enable|rotate|revoke> <repository-id>
  forge-launcher runtime rotate-tokens
  forge-launcher runtime harness list|grant|revoke ...

Starts the local Forge execution service and its PostgreSQL/Dapr infrastructure.
Infrastructure ports remain private. --host-tools publishes PostgreSQL on loopback (default 127.0.0.1:55432).
Stop preserves persistent data; reset removes volumes and requires --confirm.
Backup quiesces the runtime and exports PostgreSQL, Scheduler, and Forge data volumes.
Backups exclude target repositories and the installation credential file; they record each
registered repository's forge/* branch tips and a database credential fingerprint.
Restore verifies the archive, refuses mismatched credentials or Git drift from the recorded
tips (unless --allow-git-drift), replaces those volumes, and restarts privately.
The service API listens on 127.0.0.1:\${MYFORGE_API_PORT:-8483} and requires the generated bearer token.
"repo add" registers a repository's .git directory for the service; restart the runtime
(stop, then start) to apply registration changes. Worktrees and submodules are rejected.
Before the service listens, each mounted .git directory is restricted to owner-only access
and probed as a task UID. Tasks cannot read Git metadata or objects from any registered
repository. The repository owner's .git directory is tightened to mode 0700 and remains so
after unregistration; startup fails if task-UID denial cannot be verified. See ADR-078.
"rotate-tokens" replaces the service API and Dapr sidecar tokens; restart the runtime to apply them.
"runner enable|rotate|revoke" manages the per-repository host-runner capability; restart the runtime to apply changes.
"harness grant <harness> <VARIABLE>" grants a credential (read from stdin) to one worker harness;
grants apply to the next task attempt and are excluded from backups.
`;

export async function runtimeCli(args: readonly string[]): Promise<number> {
  const [actionValue, ...rest] = args;
  if (!actionValue || actionValue === "--help" || actionValue === "-h") {
    process.stdout.write(RUNTIME_USAGE);
    return actionValue ? 0 : 1;
  }
  if (actionValue === "repo") return repositoryCli(rest);
  if (actionValue === "runner") return hostRunnerCli(rest);
  if (actionValue === "harness") return harnessCli(getRuntimeDataDir(), rest);
  if (actionValue === "rotate-tokens") {
    if (rest.length) throw new Error("Usage: forge-launcher runtime rotate-tokens");
    await executeRuntimeAdminAction({ action: "rotate-tokens", confirmed: true });
    process.stdout.write(
      "Rotated the service API and Dapr sidecar tokens. Run \"forge-launcher runtime stop\" and " +
      "\"forge-launcher runtime start\" to apply them; until then service commands are rejected.\n",
    );
    return 0;
  }
  if (
    actionValue !== "start" && actionValue !== "status" && actionValue !== "stop" && actionValue !== "reset" &&
    actionValue !== "backup" && actionValue !== "restore"
  ) {
    throw new Error(`Unknown runtime action: ${actionValue}`);
  }
  const action = actionValue as RuntimeAction | RuntimeBackupAction;
  const options = parseOptions(action, rest);
  if (action === "reset" && !options.confirm) {
    throw new Error("Runtime reset deletes persistent data; rerun with --confirm.");
  }
  if (action !== "status") {
    let request: RuntimeAdminAction;
    switch (action) {
      case "start":
        request = {
          action,
          hostTools: options.hostTools,
          ...(options.postgresPort !== undefined ? { postgresPort: options.postgresPort } : {}),
        };
        break;
      case "stop":
      case "reset":
        request = { action, confirmed: true };
        break;
      case "backup":
        request = { action, output: options.backupPath! };
        break;
      case "restore":
        request = {
          action,
          from: options.backupPath!,
          confirmed: true,
          allowGitDrift: options.allowGitDrift ?? false,
        };
        break;
      default:
        throw new Error(`Unsupported runtime action: ${action}`);
    }
    const result = await executeRuntimeAdminAction(request);
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  await ensureRootlessPodman();
  const environment = await requireRuntimeEnvironment();
  const output = await compose("ps", options, environment);
  const containers = await listRuntimeContainers();
  const diagnostics = await runtimeDiagnostics(containers, environment.values);
  const hints = remediationHints(diagnostics.join("\n"));
  process.stdout.write(
    `${output || "No runtime containers are present."}${diagnostics.length ? `\n${diagnostics.join("\n")}` : ""}` +
    `\nNative host runner: ${await getHostRunnerProcessStatus(getRuntimeDataDir())}` +
    `${hints.map((hint) => `\nHint: ${hint}`).join("")}\n`,
  );
  return 0;
}

async function repositoryCli(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  const dataDir = getRuntimeDataDir();
  if (command === "list" && rest.length === 0) {
    const repositories = await listRegisteredRepositories(dataDir);
    process.stdout.write(repositories.length
      ? `${repositories.map((entry) => `${entry.id}\t${entry.path}`).join("\n")}\n`
      : "No repositories are registered.\n");
    return 0;
  }
  if (command === "add" && rest[0] && !rest[0].startsWith("--")) {
    let id: string | undefined;
    if (rest.length === 3 && rest[1] === "--id") id = rest[2];
    else if (rest.length !== 1) throw new Error("Usage: forge-launcher runtime repo add <repository> [--id <id>]");
    await ensureRuntimeCredentials(dataDir);
    await stopHostRunner(dataDir);
    const entry = await registerRepository(dataDir, rest[0], id);
    await updateHostRunnerCapability(dataDir, entry.id, "enable");
    await ensureHostRunnerFiles(dataDir);
    process.stdout.write(`Registered '${entry.id}' -> ${entry.path}. Restart the runtime to mount it.\n`);
    return 0;
  }
  if (command === "remove" && rest.length === 1) {
    if (!(await listRegisteredRepositories(dataDir)).some((entry) => entry.id === rest[0])) {
      throw new Error(`Repository '${rest[0]}' is not registered.`);
    }
    await stopHostRunner(dataDir);
    await unregisterRepository(dataDir, rest[0]!);
    await ensureHostRunnerFiles(dataDir);
    process.stdout.write(`Unregistered '${rest[0]}'. Restart the runtime to unmount it.\n`);
    return 0;
  }
  throw new Error("Usage: forge-launcher runtime repo add <repository> [--id <id>] | list | remove <id>");
}

async function hostRunnerCli(args: readonly string[]): Promise<number> {
  const [operation, repositoryId, ...rest] = args;
  if ((operation !== "enable" && operation !== "rotate" && operation !== "revoke")
    || !repositoryId || rest.length > 0) {
    throw new Error("Usage: forge-launcher runtime runner <enable|rotate|revoke> <repository-id>");
  }
  const result = await executeRuntimeAdminAction({
    action: "runner-capability",
    id: repositoryId,
    operation,
    confirmed: true,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required.`);
  return value;
}

function requiredConfirmation(value: unknown, operation: string): void {
  if (value !== true) throw new Error(`${operation} requires explicit confirmation.`);
}

export function parseRuntimeAdminAction(value: unknown): RuntimeAdminAction {
  if (!isRecord(value)) throw new Error("Runtime operation request must be an object.");
  const action = value.action;
  switch (action) {
    case "start":
    case "restart": {
      if (typeof value.hostTools !== "boolean") throw new Error("hostTools must be a boolean.");
      if (action === "restart") requiredConfirmation(value.confirmed, "Runtime restart");
      if (!value.hostTools && value.postgresPort !== undefined) {
        throw new Error("postgresPort requires hostTools to be enabled.");
      }
      if (value.postgresPort !== undefined &&
        (typeof value.postgresPort !== "number" || !Number.isInteger(value.postgresPort) || value.postgresPort < 1 || value.postgresPort > 65535)) {
        throw new Error("postgresPort must be an integer from 1 to 65535.");
      }
      const options = {
        hostTools: value.hostTools,
        ...(typeof value.postgresPort === "number" ? { postgresPort: value.postgresPort } : {}),
      };
      return action === "start"
        ? { action, ...options }
        : { action, ...options, confirmed: true };
    }
    case "stop":
    case "reset":
    case "rotate-tokens":
      requiredConfirmation(value.confirmed, action === "rotate-tokens" ? "Token rotation" : `Runtime ${action}`);
      return { action, confirmed: true };
    case "runner-capability":
      requiredConfirmation(value.confirmed, "Host-runner capability changes");
      if (value.operation !== "enable" && value.operation !== "rotate" && value.operation !== "revoke") {
        throw new Error("Host-runner capability operation must be enable, rotate, or revoke.");
      }
      return {
        action,
        id: requiredText(value.id, "Repository ID"),
        operation: value.operation,
        confirmed: true,
      };
    case "backup":
      return { action, output: requiredText(value.output, "Backup output path") };
    case "restore":
      requiredConfirmation(value.confirmed, "Runtime restore");
      if (typeof value.allowGitDrift !== "boolean") throw new Error("allowGitDrift must be a boolean.");
      return {
        action,
        from: requiredText(value.from, "Restore source"),
        confirmed: true,
        allowGitDrift: value.allowGitDrift,
      };
    case "repo-add":
      return {
        action,
        path: requiredText(value.path, "Repository path"),
        ...(value.id === undefined ? {} : { id: requiredText(value.id, "Repository ID") }),
      };
    case "repo-remove":
      requiredConfirmation(value.confirmed, "Repository removal");
      return { action, id: requiredText(value.id, "Repository ID"), confirmed: true };
    case "harness-grant":
      return {
        action,
        harness: requiredText(value.harness, "Harness"),
        variable: requiredText(value.variable, "Credential variable"),
        value: requiredText(value.value, "Credential value"),
      };
    case "harness-revoke":
      requiredConfirmation(value.confirmed, "Credential revocation");
      return {
        action,
        harness: requiredText(value.harness, "Harness"),
        ...(value.variable === undefined ? {} : { variable: requiredText(value.variable, "Credential variable") }),
        confirmed: true,
      };
    default:
      throw new Error(`Unknown runtime operation: ${String(action ?? "")}.`);
  }
}

export async function executeRuntimeAdminAction(
  input: unknown,
  dataDir = getRuntimeDataDir(),
): Promise<RuntimeAdminResult> {
  const action = parseRuntimeAdminAction(input);
  if (action.action === "repo-add") {
    await ensureRuntimeCredentials(dataDir);
    await stopHostRunner(dataDir);
    const entry = await registerRepository(dataDir, action.path, action.id);
    await updateHostRunnerCapability(dataDir, entry.id, "enable");
    await ensureHostRunnerFiles(dataDir);
    return { message: `Registered '${entry.id}' -> ${entry.path}. Restart the runtime to mount it.`, restartRequired: true };
  }
  if (action.action === "repo-remove") {
    if (!(await listRegisteredRepositories(dataDir)).some((entry) => entry.id === action.id)) {
      throw new Error(`Repository '${action.id}' is not registered.`);
    }
    await stopHostRunner(dataDir);
    await unregisterRepository(dataDir, action.id);
    await ensureHostRunnerFiles(dataDir);
    return { message: `Unregistered '${action.id}'. Restart the runtime to unmount it.`, restartRequired: true };
  }
  if (action.action === "harness-grant") {
    if (!HARNESS_CREDENTIAL_VARIABLES[action.harness]?.includes(action.variable)) {
      throw new Error(`Harness '${action.harness}' does not accept credential variable '${action.variable}'.`);
    }
    await grantHarnessCredential(dataDir, action.harness, action.variable, action.value);
    return {
      message: `Granted ${action.variable} to the ${action.harness} harness; it applies to the next task attempt.`,
      restartRequired: false,
    };
  }
  if (action.action === "harness-revoke") {
    const removed = await revokeHarnessCredential(dataDir, action.harness, action.variable);
    return {
      message: removed
        ? `Revoked ${action.variable ?? "all grants"} for the ${action.harness} harness.`
        : `No matching grant for the ${action.harness} harness.`,
      restartRequired: false,
    };
  }
  if (action.action === "rotate-tokens") {
    await stopHostRunner(dataDir);
    await rotateRuntimeTokens(dataDir);
    await markRuntimeRestartRequired(dataDir);
    return {
      message: "Rotated the service API and Dapr sidecar tokens. Start or restart the runtime to apply them.",
      restartRequired: true,
    };
  }
  if (action.action === "runner-capability") {
    if (!(await listRegisteredRepositories(dataDir)).some((entry) => entry.id === action.id)) {
      throw new Error(`Repository '${action.id}' is not registered.`);
    }
    await stopHostRunner(dataDir);
    await updateHostRunnerCapability(dataDir, action.id, action.operation);
    await ensureHostRunnerFiles(dataDir);
    await markRuntimeRestartRequired(dataDir);
    return {
      message: `Host-runner capability ${action.operation === "enable" ? "enabled" : `${action.operation}d`} for '${action.id}'. Restart the runtime to apply the change.`,
      restartRequired: true,
    };
  }

  await ensureRootlessPodman();
  const options: RuntimeOptions = {
    hostTools: action.action === "start" || action.action === "restart" ? action.hostTools : false,
    ...(action.action === "start" || action.action === "restart" ? { postgresPort: action.postgresPort } : {}),
    confirm: action.action === "reset" || action.action === "restore" || action.action === "restart" || action.action === "stop",
    ...(action.action === "backup" ? { backupPath: action.output } : {}),
    ...(action.action === "restore" ? { backupPath: action.from, allowGitDrift: action.allowGitDrift } : {}),
  };
  const environment = action.action === "start"
    ? await readRuntimeEnvironment(path.dirname(await ensureRuntimeCredentials(dataDir)))
    : await requireRuntimeEnvironment(dataDir);

  if (action.action === "backup") {
    await stopHostRunner(dataDir);
    await backupRuntime(action.output, options, environment);
    await startManagedHostRunner(dataDir);
    return { message: `Local runtime backup created at ${action.output}.`, restartRequired: false };
  }
  if (action.action === "restore") {
    await stopHostRunner(dataDir);
    await restoreRuntime(action.from, options, environment);
    await startManagedHostRunner(dataDir);
    return { message: "Local runtime backup restored; the execution service is ready.", restartRequired: false };
  }
  if (action.action === "start" || action.action === "restart") {
    if (action.action === "restart") {
      await stopHostRunner(dataDir);
      await compose("down", options, environment);
    }
    if (action.hostTools) await assertHostPortAvailable(action.postgresPort ?? 55432);
    await compose("up", options, environment);
    await waitForRuntimeReady(environment);
    await recordAppliedRepositories(dataDir, options);
    await startManagedHostRunner(dataDir);
    return {
      message: `Local infrastructure is running${action.hostTools ? `; PostgreSQL is on 127.0.0.1:${action.postgresPort ?? 55432}` : ""}.`,
      restartRequired: false,
    };
  }
  if (action.action === "stop" || action.action === "reset") {
    await stopHostRunner(dataDir);
    await compose("down", options, environment);
    if (action.action === "reset") {
      await removeRuntimeVolumes();
      return { message: "Local infrastructure stopped and persistent volumes were removed.", restartRequired: false };
    }
    return { message: "Local infrastructure stopped; persistent data was preserved.", restartRequired: false };
  }
  throw new Error("Unsupported runtime operation.");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function databaseCredentialFingerprint(values: RuntimeEnvironment["values"]): string {
  const hash = createHash("sha256").update("myforge-runtime-backup-database-credentials:v1");
  for (const key of LEGACY_KEYS) hash.update(`\0${key}=${values[key]}`);
  return hash.digest("hex");
}

async function forgeRefs(repositoryPath: string): Promise<Record<string, string> | undefined> {
  const listed = await runCommand("git", ["-C", repositoryPath, "for-each-ref", "--format=%(refname) %(objectname)", FORGE_REFS]);
  if (listed.code !== 0) return undefined;
  const refs: Record<string, string> = {};
  for (const line of listed.stdout.split("\n")) {
    const [name, sha] = line.trim().split(" ");
    if (name && sha) refs[name] = sha;
  }
  return refs;
}

async function recordRepositoryRefs(): Promise<BackupRepositoryRefs[]> {
  const recorded: BackupRepositoryRefs[] = [];
  for (const repository of await listRegisteredRepositories(getRuntimeDataDir())) {
    const refs = await forgeRefs(repository.path);
    if (!refs) {
      throw new Error(`Could not read Git refs of registered repository '${repository.id}' (${repository.path}); ` +
        `fix it or run "forge-launcher runtime repo remove ${repository.id}" before backing up.`);
    }
    recorded.push({ id: repository.id, path: repository.path, refs });
  }
  return recorded;
}

/**
 * Differences between Git and the forge branch tips recorded at backup time.
 * Restored stores describe integrations as of the backup; a branch that moved
 * since then either lost accepted work or holds work the stores do not know.
 */
async function gitDriftSince(backup: RuntimeBackupManifestV1): Promise<string[]> {
  const registered = new Map((await listRegisteredRepositories(getRuntimeDataDir())).map((entry) => [entry.id, entry.path]));
  const drift: string[] = [];
  for (const repository of backup.repositories ?? []) {
    const registeredPath = registered.get(repository.id);
    if (!registeredPath) {
      drift.push(`${repository.id}: not registered in this installation (run "forge-launcher runtime repo add ${repository.path} --id ${repository.id}")`);
      continue;
    }
    const current = await forgeRefs(registeredPath);
    if (!current) {
      drift.push(`${repository.id}: ${registeredPath} is not a readable Git repository`);
      continue;
    }
    for (const [ref, sha] of Object.entries(repository.refs)) {
      if (current[ref] === sha) continue;
      drift.push(`${repository.id}: ${ref} is ${current[ref] ?? "missing"}, backup recorded ${sha} ` +
        `(to match: git -C ${registeredPath} update-ref ${ref} ${sha})`);
    }
  }
  return drift;
}

function volumeName(name: (typeof RUNTIME_VOLUMES)[number]): string {
  return `${getRuntimeProject()}_${name}`;
}

async function removeRuntimeVolumes(): Promise<void> {
  for (const name of RUNTIME_VOLUMES) {
    const volume = volumeName(name);
    const inspected = await runCommand("podman", ["volume", "inspect", volume]);
    if (inspected.code !== 0) continue;
    const removed = await runCommand("podman", ["volume", "rm", volume]);
    if (removed.code !== 0) throw new Error(`Could not remove runtime volume '${volume}'.`);
  }
}

async function ensureBackupDirectoryDoesNotExist(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Backup destination already exists: ${directory}`);
}

async function backupRuntime(
  destination: string,
  options: RuntimeOptions,
  environment: RuntimeEnvironment,
): Promise<void> {
  const resolvedDestination = path.resolve(destination);
  const relativeToRuntimeData = path.relative(path.resolve(getRuntimeDataDir()), resolvedDestination);
  if (
    relativeToRuntimeData === "" ||
    (
      relativeToRuntimeData !== ".." &&
      !relativeToRuntimeData.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeToRuntimeData)
    )
  ) {
    throw new Error("Runtime backups must be stored outside the runtime data directory.");
  }
  await ensureBackupDirectoryDoesNotExist(resolvedDestination);
  const running = (await listRuntimeContainers()).some((container) => container.state === "running");
  const parent = path.dirname(resolvedDestination);
  await mkdir(parent, { recursive: true });
  const temporary = `${resolvedDestination}.tmp-${randomBytes(8).toString("hex")}`;
  await mkdir(temporary, { mode: 0o700 });

  let backupSucceeded = false;
  const failures: unknown[] = [];
  try {
    if (running) await compose("down", options, environment);
    const volumes: RuntimeBackupManifestV1["volumes"][number][] = [];
    for (const name of RUNTIME_VOLUMES) {
      const volume = volumeName(name);
      const inspected = await runCommand("podman", ["volume", "inspect", volume]);
      if (inspected.code !== 0) throw new Error(`Runtime volume '${volume}' is missing; cannot create a complete backup.`);
      const file = `${name}.tar`;
      const target = path.join(temporary, file);
      const exported = await runCommand("podman", ["volume", "export", "--output", target, volume]);
      if (exported.code !== 0) throw new Error(`Could not export runtime volume '${volume}'.`);
      await chmod(target, 0o600);
      volumes.push({ name, file, sha256: await sha256File(target) });
    }
    const manifest: RuntimeBackupManifestV1 = {
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      volumes,
      databaseCredentialFingerprint: databaseCredentialFingerprint(environment.values),
      // Recorded while quiesced, so the tips match the exported stores.
      repositories: await recordRepositoryRefs(),
    };
    await writeFile(path.join(temporary, BACKUP_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, resolvedDestination);
    backupSucceeded = true;
  } catch (error) {
    failures.push(error);
  }

  if (running) {
    try {
      await compose("up", options, environment);
      await waitForRuntimeReady(environment);
      await recordAppliedRepositories(path.dirname(environment.file), options);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!backupSucceeded) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Runtime backup or recovery failed.");
}

async function lstatOrMissing(file: string, missing: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(missing);
    throw error;
  }
}

async function readAndVerifyBackup(directory: string): Promise<RuntimeBackupManifestV1> {
  const root = path.resolve(directory);
  const rootStat = await lstatOrMissing(root, `Backup directory does not exist: ${root}`);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Backup path must be a real directory: ${root}`);
  }
  const manifestPath = path.join(root, BACKUP_FILE);
  const manifestStat = await lstatOrMissing(manifestPath, `Backup manifest is missing: ${manifestPath}`);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Backup manifest must be a regular file: ${manifestPath}`);
  }
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<RuntimeBackupManifestV1>;
  if (parsed.version !== BACKUP_VERSION || !Array.isArray(parsed.volumes) ||
    parsed.volumes.length !== RUNTIME_VOLUMES.length ||
    !parsed.createdAt || !Number.isFinite(Date.parse(parsed.createdAt))) {
    throw new Error("Runtime backup manifest has an unsupported or invalid format.");
  }
  const seen = new Set<string>();
  for (const volume of parsed.volumes) {
    if (!volume || !RUNTIME_VOLUMES.includes(volume.name) ||
      volume.file !== `${volume.name}.tar` || !/^[0-9a-f]{64}$/.test(volume.sha256) ||
      seen.has(volume.name)) {
      throw new Error("Runtime backup manifest contains an invalid volume record.");
    }
    seen.add(volume.name);
    const archivePath = path.join(root, volume.file);
    const archiveStat = await lstatOrMissing(archivePath, `Runtime backup volume '${volume.name}' is missing (${archivePath}).`);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || await sha256File(archivePath) !== volume.sha256) {
      throw new Error(`Runtime backup volume '${volume.name}' is missing or failed its integrity check.`);
    }
  }
  if (seen.size !== RUNTIME_VOLUMES.length) throw new Error("Runtime backup is missing one or more persistent volumes.");
  if (parsed.databaseCredentialFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(parsed.databaseCredentialFingerprint)) {
    throw new Error("Runtime backup manifest has an invalid credential fingerprint.");
  }
  if (parsed.repositories !== undefined && (!Array.isArray(parsed.repositories) || !parsed.repositories.every((entry) =>
    entry && typeof entry.id === "string" && typeof entry.path === "string" && path.isAbsolute(entry.path) &&
    entry.refs && typeof entry.refs === "object" &&
    Object.entries(entry.refs).every(([ref, sha]) => ref.startsWith(FORGE_REFS) && typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha))))) {
    throw new Error("Runtime backup manifest contains an invalid repository record.");
  }
  return parsed as RuntimeBackupManifestV1;
}

/**
 * Verifies a backup and that this installation can restore it consistently:
 * matching database credentials and forge branches still at the recorded tips.
 */
export async function verifyRestoreSource(
  source: string,
  environment: RuntimeEnvironment,
  allowGitDrift: boolean,
): Promise<RuntimeBackupManifestV1> {
  const backup = await readAndVerifyBackup(source);
  if (backup.databaseCredentialFingerprint && backup.databaseCredentialFingerprint !== databaseCredentialFingerprint(environment.values)) {
    throw new Error(
      "The backup's PostgreSQL data was initialized with different database credentials than this installation. " +
      `Copy ${CREDENTIALS_FILE} from the installation that created the backup into ${path.dirname(environment.file)} ` +
      "(mode 0600) and rerun the restore.",
    );
  }
  if (!backup.repositories) {
    process.stderr.write("Warning: this backup predates Git ref recording; check that forge branches match the backup time.\n");
  } else {
    const drift = await gitDriftSince(backup);
    if (drift.length && !allowGitDrift) {
      throw new Error(
        "Git no longer matches the backup, so the restored stores would be out of sync with the repositories:\n" +
        `${drift.map((line) => `  ${line}`).join("\n")}\n` +
        "Reset the listed refs to the recorded commits (and register missing repositories), or rerun with " +
        "--allow-git-drift: runs whose integrated commits are missing then fail, and work integrated after the " +
        "backup may be integrated again.",
      );
    }
    for (const line of drift) process.stderr.write(`Warning: Git drift accepted: ${line}\n`);
  }
  return backup;
}

async function restoreRuntime(
  source: string,
  options: RuntimeOptions,
  environment: RuntimeEnvironment,
): Promise<void> {
  const backup = await verifyRestoreSource(source, environment, options.allowGitDrift ?? false);
  await compose("down", { ...options, confirm: true }, environment);
  for (const volume of backup.volumes) {
    const name = volumeName(volume.name);
    const inspected = await runCommand("podman", ["volume", "inspect", name]);
    if (inspected.code === 0) {
      const removed = await runCommand("podman", ["volume", "rm", name]);
      if (removed.code !== 0) throw new Error(`Could not remove existing runtime volume '${name}' for restore.`);
    }
    const created = await runCommand("podman", ["volume", "create", name]);
    if (created.code !== 0) throw new Error(`Could not create runtime volume '${name}' for restore.`);
    const imported = await runCommand("podman", ["volume", "import", name, path.join(path.resolve(source), volume.file)]);
    if (imported.code !== 0) throw new Error(`Could not restore runtime volume '${name}'.`);
  }
  await compose("up", options, environment);
  await waitForRuntimeReady(environment);
  await recordAppliedRepositories(path.dirname(environment.file), options);
}
