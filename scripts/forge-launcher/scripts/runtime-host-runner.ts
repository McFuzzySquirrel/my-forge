import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listRegisteredRepositories } from "./runtime-repositories.ts";

const CAPABILITY_FILE = "host-runner-capabilities.json";
const HASH_FILE = "host-runner-capability-hashes.json";
const PID_FILE = "host-runner.pid";
const LOG_FILE = "host-runner.log";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HostRunnerFiles {
  readonly capabilitiesFile: string;
  readonly hashesFile: string;
  readonly repositoriesFile: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly enabledRepositoryIds: readonly string[];
}

interface HostRunnerPidFileV1 {
  readonly version: 1;
  readonly pid: number;
  readonly instanceId: string;
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
  if (process.platform !== "win32") await chmod(file, 0o600);
}

async function readCapabilities(dataDir: string): Promise<Record<string, string> | undefined> {
  const file = path.join(dataDir, CAPABILITY_FILE);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()
    || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error("Host-runner capability file must be an owner-only regular file.");
  }
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || !(parsed as { capabilities?: unknown }).capabilities
    || typeof (parsed as { capabilities: unknown }).capabilities !== "object"
    || Array.isArray((parsed as { capabilities: unknown }).capabilities)) {
    throw new Error("Host-runner capability file has an invalid schema.");
  }
  const capabilities = (parsed as { capabilities: Record<string, unknown> }).capabilities;
  if (Object.entries(capabilities).some(([id, value]) =>
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || typeof value !== "string" || !CAPABILITY_PATTERN.test(value))) {
    throw new Error("Host-runner capability file contains an invalid entry.");
  }
  return capabilities as Record<string, string>;
}

async function writeCapabilities(
  dataDir: string,
  active: Readonly<Record<string, string>>,
): Promise<void> {
  const hashes = Object.fromEntries(Object.entries(active).map(([id, capability]) => [
    id,
    `sha256:${createHash("sha256").update(capability, "utf8").digest("hex")}`,
  ]));
  const capabilitiesFile = path.join(dataDir, CAPABILITY_FILE);
  const hashesFile = path.join(dataDir, HASH_FILE);
  await writeAtomic(capabilitiesFile, `${JSON.stringify({ version: 1, capabilities: active }, null, 2)}\n`);
  await writeAtomic(hashesFile, `${JSON.stringify({ version: 1, capabilities: hashes }, null, 2)}\n`);
}

async function existingOrInitialCapabilities(
  dataDir: string,
  repositoryIds: readonly string[],
): Promise<Record<string, string>> {
  const existing = await readCapabilities(dataDir);
  if (existing) return Object.fromEntries(repositoryIds.flatMap((id) =>
    existing[id] ? [[id, existing[id]!]] : []));
  return Object.fromEntries(repositoryIds.map((id) => [id, randomBytes(32).toString("base64url")]));
}

export async function listEnabledHostRunnerRepositories(dataDir: string): Promise<string[]> {
  return Object.keys(await readCapabilities(dataDir) ?? {});
}

export async function ensureHostRunnerFiles(dataDir: string): Promise<HostRunnerFiles> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dataDir, 0o700);
  const repositories = await listRegisteredRepositories(dataDir);
  const active = await existingOrInitialCapabilities(dataDir, repositories.map(({ id }) => id));
  await writeCapabilities(dataDir, active);
  const capabilitiesFile = path.join(dataDir, CAPABILITY_FILE);
  const hashesFile = path.join(dataDir, HASH_FILE);
  return {
    capabilitiesFile,
    hashesFile,
    repositoriesFile: path.join(dataDir, "repositories.json"),
    repositories: Object.fromEntries(repositories.map(({ id, path: repositoryPath }) => [id, repositoryPath])),
    enabledRepositoryIds: Object.keys(active),
  };
}

export async function updateHostRunnerCapability(
  dataDir: string,
  repositoryId: string,
  operation: "enable" | "rotate" | "revoke",
): Promise<void> {
  const repositories = await listRegisteredRepositories(dataDir);
  if (!repositories.some(({ id }) => id === repositoryId)) {
    throw new Error(`Repository '${repositoryId}' is not registered.`);
  }
  const active = await existingOrInitialCapabilities(dataDir, repositories.map(({ id }) => id));
  if (operation === "revoke") {
    delete active[repositoryId];
  } else if (operation === "rotate") {
    if (!active[repositoryId]) throw new Error(`Host-runner capability for '${repositoryId}' is revoked; enable it first.`);
    active[repositoryId] = randomBytes(32).toString("base64url");
  } else if (!active[repositoryId]) {
    active[repositoryId] = randomBytes(32).toString("base64url");
  }
  await writeCapabilities(dataDir, active);
}

async function readPidFile(dataDir: string): Promise<HostRunnerPidFileV1 | undefined> {
  const file = path.join(dataDir, PID_FILE);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()
    || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error("Host-runner process record must be an owner-only regular file.");
  }
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as { version?: unknown }).version !== 1
    || !Number.isSafeInteger((value as { pid?: unknown }).pid)
    || Number((value as { pid: number }).pid) <= 0
    || typeof (value as { instanceId?: unknown }).instanceId !== "string") {
    throw new Error("Host-runner process record is invalid.");
  }
  return value as HostRunnerPidFileV1;
}

async function processCommand(pid: number): Promise<string | undefined> {
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Write($p.CommandLine) }`]
    : ["-p", String(pid), "-o", "args="];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? output : undefined));
  });
}

async function ownsProcess(record: HostRunnerPidFileV1): Promise<boolean> {
  const command = await processCommand(record.pid);
  return Boolean(command?.includes("--instance-id=" + record.instanceId)
    && command.includes("host-runner.ts"));
}

async function readLogTail(file: string, maxBytes = 4_000): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > maxBytes ? `[truncated]\n${text.slice(-maxBytes)}` : text;
  } catch {
    return "";
  }
}

export async function getHostRunnerProcessStatus(
  dataDir: string,
): Promise<"disabled" | "running" | "stopped"> {
  if ((await listEnabledHostRunnerRepositories(dataDir)).length === 0) return "disabled";
  const record = await readPidFile(dataDir);
  return record && await ownsProcess(record) ? "running" : "stopped";
}

export async function startHostRunner(
  dataDir: string,
  apiToken: string,
  apiPort: number,
  engineDir: string,
  packageDir: string,
): Promise<void> {
  const files = await ensureHostRunnerFiles(dataDir);
  if (files.enabledRepositoryIds.length === 0) return;
  const existing = await readPidFile(dataDir);
  if (existing && await ownsProcess(existing)) return;
  if (existing) await unlink(path.join(dataDir, PID_FILE));

  const script = path.join(engineDir, "scripts", "host-runner.ts");
  const logPath = path.join(dataDir, LOG_FILE);
  const log = await open(logPath, "a", 0o600);
  const instanceId = randomUUID();
  const readyFile = path.join(dataDir, `host-runner-ready-${instanceId}`);
  const env = { ...process.env };
  for (const name of [
    "MYFORGE_API_TOKEN",
    "DAPR_API_TOKEN",
    "APP_DB_PASSWORD",
    "POSTGRES_PASSWORD",
    "POSTGRES_SUPERUSER_PASSWORD",
    "DAPR_DB_PASSWORD",
  ]) delete env[name];
  env.MYFORGE_HOST_RUNNER_BASE_URL = `http://127.0.0.1:${apiPort}`;
  env.MYFORGE_HOST_RUNNER_API_TOKEN = apiToken;
  env.MYFORGE_HOST_RUNNER_REPOSITORIES_FILE = files.repositoriesFile;
  env.MYFORGE_HOST_RUNNER_CAPABILITIES_FILE = files.capabilitiesFile;
  env.MYFORGE_HOST_RUNNER_WORKSPACES_DIR = path.join(dataDir, "host-runner-workspaces");
  env.MYFORGE_HOST_RUNNER_INSTANCE_ID = instanceId;
  env.MYFORGE_HOST_RUNNER_READY_FILE = readyFile;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, `--instance-id=${instanceId}`],
    { cwd: packageDir, detached: true, env, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
  );
  let spawnError: Error | undefined;
  let exited = false;
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", () => { exited = true; });
  await log.close();
  if (!child.pid) {
    throw new Error("Could not start the native host runner.", { cause: spawnError });
  }
  child.unref();
  await writeAtomic(path.join(dataDir, PID_FILE), `${JSON.stringify({ version: 1, pid: child.pid, instanceId })}\n`);
  const startDeadline = Date.now() + 30_000;
  while (Date.now() < startDeadline) {
    if (spawnError || exited || child.exitCode !== null || child.signalCode !== null) {
      const tail = await readLogTail(logPath);
      await stopHostRunner(dataDir);
      throw new Error(
        `Native host runner exited during startup; inspect ${logPath}.`
        + (tail ? `\n${tail}` : ""),
        { cause: spawnError },
      );
    }
    try {
      const readyInstanceId = await readFile(readyFile, "utf8");
      if (readyInstanceId !== instanceId) {
        await stopHostRunner(dataDir);
        throw new Error("Native host runner returned an invalid startup marker.");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  const tail = await readLogTail(logPath);
  await stopHostRunner(dataDir);
  throw new Error(
    `Native host runner did not become ready within 30 seconds; inspect ${logPath}.`
    + (tail ? `\n${tail}` : ""),
  );
}

export async function stopHostRunner(dataDir: string): Promise<void> {
  const record = await readPidFile(dataDir);
  if (!record) return;
  const file = path.join(dataDir, PID_FILE);
  if (!await ownsProcess(record)) {
    await unlink(path.join(dataDir, `host-runner-ready-${record.instanceId}`)).catch(() => undefined);
    await unlink(file);
    return;
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await ownsProcess(record)) await delay(200);
  if (await ownsProcess(record)) {
    process.kill(record.pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  }
  await unlink(path.join(dataDir, `host-runner-ready-${record.instanceId}`)).catch(() => undefined);
  await unlink(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
