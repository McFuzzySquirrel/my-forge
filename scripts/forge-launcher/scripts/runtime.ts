import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveResources } from "./resources.ts";

const CREDENTIALS_FILE = "runtime.env";
const KEYS = ["POSTGRES_SUPERUSER_PASSWORD", "DAPR_DB_PASSWORD", "APP_DB_PASSWORD"] as const;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

type RuntimeAction = "start" | "status" | "stop" | "reset";

interface RuntimeOptions {
  readonly hostTools: boolean;
  readonly postgresPort?: number;
  readonly confirm: boolean;
}

interface RuntimeEnvironment {
  readonly file: string;
  readonly values: Readonly<Record<(typeof KEYS)[number], string>>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function getRuntimeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path;
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

async function readRuntimeEnvironment(directory: string): Promise<RuntimeEnvironment> {
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
      if (separator < 1) throw new Error(`Runtime credentials are malformed: ${file}`);
      const key = line.slice(0, separator);
      if (entries.has(key)) throw new Error(`Runtime credentials contain a duplicate setting: ${key}`);
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
    throw new Error(`Runtime credentials are invalid; refusing to replace them: ${file}`);
  }
  throw new Error(`Timed out reading runtime credentials: ${file}`);
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
  return readRuntimeEnvironment(directory);
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
  }
  return (await readRuntimeEnvironment(directory)).file;
}

function parseOptions(action: RuntimeAction, args: readonly string[]): RuntimeOptions {
  const options: { hostTools: boolean; postgresPort?: number; confirm: boolean } = {
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
    } else if (argument === "--confirm" && action === "reset") {
      options.confirm = true;
    } else {
      throw new Error(`Unknown runtime option: ${argument}`);
    }
  }
  if (options.postgresPort !== undefined && !options.hostTools) {
    throw new Error("--postgres-port requires --host-tools.");
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
    throw new Error("Podman is required to manage the local runtime.");
  }
  if (result.code !== 0) throw new Error("Unable to inspect Podman; confirm the rootless Podman service is available.");
  let info: { host?: { security?: { rootless?: boolean } } };
  try {
    info = JSON.parse(result.stdout) as { host?: { security?: { rootless?: boolean } } };
  } catch {
    throw new Error("Podman returned invalid runtime information.");
  }
  if (info.host?.security?.rootless !== true) throw new Error("Rootless Podman is required for the local runtime.");
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

const SERVICES = ["postgres", "placement", "scheduler", "daprd"] as const;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;

export interface RuntimeContainer {
  readonly name: string;
  readonly service: string;
  readonly state: string;
}

/** Returns the services that are missing or not running; empty when all are up. */
export function unreadyServices(containers: readonly RuntimeContainer[]): string[] {
  return SERVICES.filter((service) => !containers.some((container) => container.service === service && container.state === "running"));
}

async function listRuntimeContainers(): Promise<RuntimeContainer[]> {
  const result = await runCommand("podman", [
    "ps", "-a", "--filter", "label=com.docker.compose.project=myforge-runtime", "--format", "json",
  ]);
  if (result.code !== 0) throw new Error("Unable to list local runtime containers with Podman.");
  const entries = JSON.parse(result.stdout || "[]") as Array<{
    Names?: string[]; State?: string; Labels?: Record<string, string>;
  }>;
  return entries.map((entry) => ({
    name: entry.Names?.[0] ?? "",
    service: entry.Labels?.["com.docker.compose.service"] ?? "",
    state: entry.State ?? "unknown",
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
  const details: string[] = [];
  for (const container of containers.filter((entry) => entry.state !== "running")) {
    const logs = await runCommand("podman", ["logs", "--tail", "10", container.name]).catch(() => undefined);
    const text = logs ? redact(`${logs.stdout}${logs.stderr}`, environment.values).trim() : "";
    details.push(`${container.service}: ${container.state}${text ? `\n${text}` : ""}`);
  }
  throw new Error(
    `Local infrastructure did not become ready: ${pending.join(", ")}.` +
    `${details.length ? `\n${details.join("\n")}` : ""}\n` +
    `Run "forge-launcher runtime status" to inspect it and "forge-launcher runtime stop" to stop it.`,
  );
}

function redact(output: string, values: RuntimeEnvironment["values"]): string {
  let safe = output;
  for (const secret of Object.values(values)) {
    if (secret.length > 0) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/(password=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:POSTGRES|DAPR|APP)_DB_PASSWORD|POSTGRES_SUPERUSER_PASSWORD)=([^\s]+)/g, "$1=[REDACTED]");
}

async function compose(
  action: "up" | "ps" | "down",
  options: RuntimeOptions,
  environment: RuntimeEnvironment,
): Promise<string> {
  const { deploymentDir } = resolveResources();
  const baseFile = path.join(deploymentDir, "compose.yaml");
  const args = ["compose", "--env-file", environment.file, "-f", baseFile];
  if (action === "up" && options.hostTools) {
    args.push("-f", path.join(deploymentDir, "compose.host-tools.yaml"));
  }
  args.push(action);
  if (action === "up") args.push("-d");
  if (action === "down" && options.confirm) args.push("-v");
  const env = { ...process.env };
  delete env.POSTGRES_SUPERUSER_PASSWORD;
  delete env.DAPR_DB_PASSWORD;
  delete env.APP_DB_PASSWORD;
  if (action === "up" && options.hostTools) {
    env.POSTGRES_PORT = String(options.postgresPort ?? 55432);
  }
  const result = await runCommand("podman", args, env);
  const output = redact(`${result.stdout}${result.stderr}`, environment.values).trim();
  if (result.code !== 0) {
    const details = output.split(/\r?\n/).slice(-20).join("\n");
    throw new Error(`Podman Compose ${action} failed (exit ${result.code}).${details ? `\n${details}` : ""}`);
  }
  return output;
}

const RUNTIME_USAGE = `Usage:
  forge-launcher runtime start [--host-tools] [--postgres-port <n>]
  forge-launcher runtime status
  forge-launcher runtime stop
  forge-launcher runtime reset --confirm

Starts the local PostgreSQL and Dapr infrastructure. Internal ports remain
private. --host-tools publishes PostgreSQL on loopback (default 127.0.0.1:55432).
Stop preserves persistent data; reset removes volumes and requires --confirm.
`;

export async function runtimeCli(args: readonly string[]): Promise<number> {
  const [actionValue, ...rest] = args;
  if (!actionValue || actionValue === "--help" || actionValue === "-h") {
    process.stdout.write(RUNTIME_USAGE);
    return actionValue ? 0 : 1;
  }
  if (actionValue !== "start" && actionValue !== "status" && actionValue !== "stop" && actionValue !== "reset") {
    throw new Error(`Unknown runtime action: ${actionValue}`);
  }
  const action: RuntimeAction = actionValue;
  const options = parseOptions(action, rest);
  if (action === "reset" && !options.confirm) {
    throw new Error("Runtime reset deletes persistent data; rerun with --confirm.");
  }
  await ensureRootlessPodman();
  if (action === "start" && options.hostTools) {
    await assertHostPortAvailable(options.postgresPort ?? 55432);
  }
  const environment = action === "start"
    ? await readRuntimeEnvironment(path.dirname(await ensureRuntimeCredentials()))
    : await requireRuntimeEnvironment();
  const operation = action === "start" ? "up" : action === "status" ? "ps" : "down";
  const output = await compose(operation, options, environment);
  if (action === "start") await waitForRuntimeReady(environment);
  if (action === "start") {
    process.stdout.write(`Local infrastructure is running${options.hostTools ? `; PostgreSQL is on 127.0.0.1:${options.postgresPort ?? 55432}` : ""}.\n`);
  } else if (action === "stop") {
    process.stdout.write("Local infrastructure stopped; persistent data was preserved.\n");
  } else if (action === "reset") {
    process.stdout.write("Local infrastructure stopped and persistent volumes were removed.\n");
  } else {
    process.stdout.write(`${output || "No runtime containers are present."}\n`);
  }
  return 0;
}
