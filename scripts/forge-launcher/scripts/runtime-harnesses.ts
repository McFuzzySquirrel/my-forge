import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Credential variables each worker harness may receive. Mirrors
 * tools/dapr-engine/service/harness-credentials.ts (a parity test keeps them aligned);
 * the worker re-filters grants against its own copy.
 */
export const HARNESS_CREDENTIAL_VARIABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  copilot: Object.freeze(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]),
  claude: Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
  opencode: Object.freeze([
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENCODE_AUTH_JSON",
  ]),
});

/** Directory bind-mounted read-only into the worker; files inside are replaced atomically. */
export const HARNESS_GRANTS_DIR = "harness-grants";
const GRANTS_FILE = "grants.json";

type Grants = Record<string, Record<string, string>>;

export function harnessGrantsDir(dataDir: string): string {
  return path.join(dataDir, HARNESS_GRANTS_DIR);
}

function grantsFile(dataDir: string): string {
  return path.join(harnessGrantsDir(dataDir), GRANTS_FILE);
}

function assertVariable(harness: string, variable?: string): void {
  const allowed = HARNESS_CREDENTIAL_VARIABLES[harness];
  if (!allowed) {
    throw new Error(`Unknown harness '${harness}'; credential grants apply to: ${Object.keys(HARNESS_CREDENTIAL_VARIABLES).join(", ")}.`);
  }
  if (variable !== undefined && !allowed.includes(variable)) {
    throw new Error(`Harness '${harness}' accepts only: ${allowed.join(", ")}.`);
  }
}

async function readGrants(dataDir: string): Promise<Grants> {
  let text: string;
  try {
    text = await readFile(grantsFile(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text) as { schemaVersion?: unknown; grants?: unknown };
  if (parsed.schemaVersion !== 1 || !parsed.grants || typeof parsed.grants !== "object" || Array.isArray(parsed.grants)) {
    throw new Error(`Harness credential grants are invalid: ${grantsFile(dataDir)}`);
  }
  const grants: Grants = {};
  for (const [harness, variables] of Object.entries(parsed.grants as Record<string, unknown>)) {
    if (!HARNESS_CREDENTIAL_VARIABLES[harness] || !variables || typeof variables !== "object") continue;
    grants[harness] = Object.fromEntries(Object.entries(variables as Record<string, unknown>)
      .filter((entry): entry is [string, string] =>
        HARNESS_CREDENTIAL_VARIABLES[harness].includes(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0));
  }
  return grants;
}

async function writeGrants(dataDir: string, grants: Grants): Promise<void> {
  const file = grantsFile(dataDir);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, grants }, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
}

async function ensureGrantsFile(dataDir: string): Promise<void> {
  const file = grantsFile(dataDir);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeGrants(dataDir, {});
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Harness credential grants must be a regular file: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Harness credential grants are not owned by the current user: ${file}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await chmod(file, 0o600);
}

/**
 * The worker accepts exactly one OpenCode provider credential per attempt.
 * Reject other exports here so an invalid grant fails at grant time rather
 * than on every task attempt.
 */
export function validateOpenCodeAuthGrant(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OPENCODE_AUTH_JSON must be valid JSON from 'opencode auth export'.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("OPENCODE_AUTH_JSON must contain exactly one exported provider credential.");
  }
  const entry = parsed[0];
  const integrationID = entry && typeof entry === "object" && "integrationID" in entry
    ? (entry as { integrationID?: unknown }).integrationID
    : undefined;
  if (typeof integrationID !== "string" || integrationID.length === 0) {
    throw new Error("OPENCODE_AUTH_JSON must contain one credential with a provider identifier.");
  }
}

/**
 * Creates the private grants directory (and an empty grant file) the worker
 * mounts. Returns the directory for the compose environment.
 */
export async function ensureHarnessGrants(dataDir: string): Promise<string> {
  const directory = harnessGrantsDir(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Harness grants must be a directory: ${directory}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Harness grants are not owned by the current user: ${directory}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await chmod(directory, 0o700);
  await ensureGrantsFile(dataDir);
  return directory;
}

export async function grantHarnessCredential(dataDir: string, harness: string, variable: string, value: string): Promise<void> {
  assertVariable(harness, variable);
  const trimmed = value.replace(/\r?\n$/, "");
  if (!trimmed || /[\0\r\n]/.test(trimmed)) throw new Error(`The value for ${variable} must be a single non-empty line.`);
  if (harness === "opencode" && variable === "OPENCODE_AUTH_JSON") validateOpenCodeAuthGrant(trimmed);
  await ensureHarnessGrants(dataDir);
  const grants = await readGrants(dataDir);
  grants[harness] = { ...grants[harness], [variable]: trimmed };
  await writeGrants(dataDir, grants);
}

/** Removes one variable, or every grant for the harness when no variable is given. */
export async function revokeHarnessCredential(dataDir: string, harness: string, variable?: string): Promise<boolean> {
  assertVariable(harness, variable);
  const grants = await readGrants(dataDir);
  const current = grants[harness];
  if (!current || (variable !== undefined && !(variable in current))) return false;
  if (variable === undefined) delete grants[harness];
  else {
    const { [variable]: _removed, ...rest } = current;
    if (Object.keys(rest).length) grants[harness] = rest;
    else delete grants[harness];
  }
  await ensureHarnessGrants(dataDir);
  await writeGrants(dataDir, grants);
  return true;
}

/** Granted variable names per harness; values are never returned. */
export async function listHarnessGrants(dataDir: string): Promise<Record<string, string[]>> {
  const grants = await readGrants(dataDir);
  return Object.fromEntries(Object.keys(HARNESS_CREDENTIAL_VARIABLES)
    .map((harness) => [harness, Object.keys(grants[harness] ?? {}).sort()]));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const HARNESS_USAGE = `Usage:
  forge-launcher runtime harness list
  forge-launcher runtime harness grant <harness> <VARIABLE> [--from-env]
  forge-launcher runtime harness revoke <harness> [VARIABLE]

Grants a credential to one worker harness (copilot, claude, opencode). "grant" reads the
value from standard input, or from the same-named environment variable with --from-env,
and never prints it. Grants apply to the next task attempt without a restart.
`;

export async function harnessCli(dataDir: string, args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HARNESS_USAGE);
    return action ? 0 : 1;
  }
  if (action === "list") {
    if (rest.length) throw new Error("Usage: forge-launcher runtime harness list");
    const listed = await listHarnessGrants(dataDir);
    for (const [harness, variables] of Object.entries(listed)) {
      process.stdout.write(`${harness}\t${variables.length ? variables.join(", ") : "(no grants)"}\n`);
    }
    return 0;
  }
  if (action === "grant") {
    const fromEnv = rest.includes("--from-env");
    const positional = rest.filter((arg) => arg !== "--from-env");
    if (positional.length !== 2) throw new Error("Usage: forge-launcher runtime harness grant <harness> <VARIABLE> [--from-env]");
    const [harness, variable] = positional;
    assertVariable(harness, variable);
    let value: string | undefined;
    if (fromEnv) {
      value = process.env[variable];
      if (!value) throw new Error(`${variable} is not set in the environment.`);
    } else {
      if (process.stdin.isTTY) process.stderr.write(`Enter ${variable} for ${harness}, then press Ctrl-D:\n`);
      value = await readStdin();
    }
    await grantHarnessCredential(dataDir, harness, variable, value);
    process.stdout.write(`Granted ${variable} to the ${harness} harness; it applies to the next task attempt.\n`);
    return 0;
  }
  if (action === "revoke") {
    if (rest.length < 1 || rest.length > 2) throw new Error("Usage: forge-launcher runtime harness revoke <harness> [VARIABLE]");
    const [harness, variable] = rest;
    const removed = await revokeHarnessCredential(dataDir, harness, variable);
    process.stdout.write(removed
      ? `Revoked ${variable ?? "all grants"} for the ${harness} harness.\n`
      : `No matching grant for the ${harness} harness.\n`);
    return 0;
  }
  throw new Error(`Unknown runtime harness action: ${action}`);
}
