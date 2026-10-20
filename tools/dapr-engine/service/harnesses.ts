import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ClaudeAdapter } from "../execution/harness/claude-adapter.ts";
import { CopilotAdapter } from "../execution/harness/copilot-adapter.ts";
import { OpenCodeAdapter } from "../execution/harness/opencode-adapter.ts";
import { StubAdapter } from "../execution/harness/stub-adapter.ts";
import type { HarnessAdapter } from "../execution/types.ts";
import { HARNESS_CREDENTIAL_VARIABLES } from "./harness-credentials.ts";
export { HARNESS_CREDENTIAL_VARIABLES } from "./harness-credentials.ts";

interface HarnessBinary {
  readonly env: string;
  readonly bin: string;
  readonly create: () => HarnessAdapter;
  /** Non-secret settings the CLI needs inside the root-run worker container. */
  readonly rootSettings?: Readonly<Record<string, string>>;
}

const HARNESS_BINARIES: Readonly<Record<string, HarnessBinary>> = {
  copilot: { env: "COPILOT_BIN", bin: "copilot", create: () => new CopilotAdapter() },
  // Claude Code refuses bypassPermissions as root unless told it is sandboxed;
  // the worker container (and its per-attempt workspace) is that sandbox.
  claude: { env: "CLAUDE_BIN", bin: "claude", create: () => new ClaudeAdapter(), rootSettings: { IS_SANDBOX: "1" } },
  opencode: { env: "OPENCODE_BIN", bin: "opencode", create: () => new OpenCodeAdapter() },
};

export interface HarnessGrantsV1 {
  readonly schemaVersion: 1;
  readonly grants: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type HarnessUnavailableReason = "unknown-harness" | "unsupported-adapter-version" | "not-installed" | "no-credentials";

export interface ServiceHarnessV1 {
  readonly adapterVersions: readonly string[];
  /** Undefined when the harness can run now; otherwise why it cannot. */
  unavailable?(): HarnessUnavailableReason | undefined;
  create(): HarnessAdapter;
  /** Resolves the granted credentials for one attempt; never persisted. */
  readonly credentials?: () => Promise<Readonly<Record<string, string>>>;
}

/** Parses the launcher-written grant file; malformed files fail closed. */
export function parseHarnessGrants(text: string): HarnessGrantsV1 {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("Harness credential grants must be a schemaVersion 1 document");
  }
  const raw = (parsed as { grants?: unknown }).grants;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Harness credential grants are missing 'grants'");
  const grants: Record<string, Record<string, string>> = {};
  for (const [harness, variables] of Object.entries(raw)) {
    const allowed = HARNESS_CREDENTIAL_VARIABLES[harness];
    if (!allowed || !variables || typeof variables !== "object" || Array.isArray(variables)) continue;
    const scoped: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      if (allowed.includes(name) && typeof value === "string" && value.length > 0 && !value.includes("\0")) scoped[name] = value;
    }
    grants[harness] = scoped;
  }
  return { schemaVersion: 1, grants };
}

/** Reads grants; an absent file means no grants. */
export function readHarnessGrants(file: string | undefined): HarnessGrantsV1 {
  if (!file) return { schemaVersion: 1, grants: {} };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, grants: {} };
    throw error;
  }
  return parseHarnessGrants(text);
}

/** Resolves a CLI on PATH (or an absolute override) without spawning it. */
export function resolveExecutable(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  const candidates = isAbsolute(name) ? [name] : pathValue.split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      if (!lstatSync(candidate).isDirectory()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not present in this PATH entry.
    }
  }
  return undefined;
}

export interface DefaultServiceHarnessOptions {
  /** Launcher-managed grant file mounted read-only into the worker. */
  readonly credentialsFile?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Whether harness processes run as root (the worker container default). */
  readonly root?: boolean;
}

/**
 * Harnesses the containerized worker can execute: the offline stub, plus each
 * CLI harness provisioned in the worker image. A CLI harness is admitted only
 * when its binary is installed and the operator has granted at least one of
 * its credential variables; grants are re-read for every attempt.
 */
export function defaultServiceHarnesses(options: DefaultServiceHarnessOptions = {}): ReadonlyMap<string, ServiceHarnessV1> {
  const environment = options.environment ?? process.env;
  const root = options.root ?? process.getuid?.() === 0;
  const harnesses = new Map<string, ServiceHarnessV1>([
    ["stub", { adapterVersions: ["1"], create: () => new StubAdapter() }],
  ]);
  for (const [id, binary] of Object.entries(HARNESS_BINARIES)) {
    const granted = (): Readonly<Record<string, string>> => readHarnessGrants(options.credentialsFile).grants[id] ?? {};
    harnesses.set(id, {
      adapterVersions: ["1"],
      unavailable: () => {
        if (!resolveExecutable(environment[binary.env] ?? binary.bin, environment.PATH)) return "not-installed";
        return Object.keys(granted()).length ? undefined : "no-credentials";
      },
      create: binary.create,
      credentials: async () => ({ ...(root ? binary.rootSettings : undefined), ...granted() }),
    });
  }
  return harnesses;
}

export function harnessUnavailableDetail(id: string, adapterVersion: string, reason: HarnessUnavailableReason): string {
  switch (reason) {
    case "not-installed":
      return `Harness '${id}' is not installed in the local service worker; rebuild it with "forge-launcher runtime start".`;
    case "no-credentials":
      return `Harness '${id}' has no credential grant; run "forge-launcher runtime harness grant ${id} <VARIABLE>" (allowed: ${(HARNESS_CREDENTIAL_VARIABLES[id] ?? []).join(", ")}).`;
    case "unsupported-adapter-version":
      return `Harness '${id}@${adapterVersion}' is not supported by the local service worker.`;
    default:
      return `Harness '${id}' is not available in the local service worker (available: stub, copilot, claude, opencode).`;
  }
}
