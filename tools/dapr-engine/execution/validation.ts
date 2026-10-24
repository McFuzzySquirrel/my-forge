import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "./harness/run.ts";
import { quarantineTaskProcessIdentity } from "./isolation.ts";
import type { ProcessIdentityV1 } from "./types.ts";

const MAX_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const VALIDATION_TRUNCATION = "[truncated]\n";

export interface ValidationCommandResult {
  readonly command: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ValidationRunResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly results: readonly ValidationCommandResult[];
}

export interface ValidationRunOptions {
  readonly task: { readonly validationCommands: readonly string[] };
  readonly workspacePath: string;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly processIdentity?: ProcessIdentityV1;
  readonly signal?: AbortSignal;
  /**
   * Install project dependencies before the first command. Service workers
   * execute in a clean clone, so validation would otherwise run without the
   * project's dev dependencies. Legacy/local callers that run in the operator's
   * checkout leave this off.
   */
  readonly installDependencies?: boolean;
  /** Redacts secret values from bounded command output. */
  readonly redact?: (value: string) => string;
}

function boundedValidationOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_VALIDATION_OUTPUT_BYTES) return value;
  const budget = MAX_VALIDATION_OUTPUT_BYTES - Buffer.byteLength(VALIDATION_TRUNCATION, "utf8");
  return `${VALIDATION_TRUNCATION}${bytes.subarray(Math.max(0, bytes.byteLength - budget)).toString("utf8")}`;
}

function output(value: string, redact?: (text: string) => string): string {
  const bounded = boundedValidationOutput(value);
  return redact ? redact(bounded) : bounded;
}

async function installDependencies(
  options: ValidationRunOptions,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const workspacePath = options.workspacePath;
  const hasProject = existsSync(join(workspacePath, "package.json"))
    && existsSync(join(workspacePath, "package-lock.json"))
    && !existsSync(join(workspacePath, "node_modules"));
  if (!hasProject) return { ok: true };

  const result = await runCommand("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: workspacePath,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: 10 * 1024 * 1024,
    env: { ...(options.environment ?? {}) },
    inheritEnvironment: false,
    reapProcessGroupOnExit: true,
    ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.processCleanup === "unconfirmed" && options.processIdentity) {
    quarantineTaskProcessIdentity(options.processIdentity);
  }
  if (result.status === 0) return { ok: true };
  const detail = output(result.stderr || result.stdout, options.redact).trim().slice(-8_000);
  return {
    ok: false,
    reason: `dependency install failed (exit ${String(result.status)}): npm ci${detail ? `\n${detail}` : ""}`,
  };
}

/**
 * Runs a task's manifest validation commands in a workspace. This is the one
 * validation implementation shared by host execution, the service worker and
 * local verification, so dependency installation and evidence shaping cannot
 * drift between execution modes.
 */
export async function runValidationCommands(
  options: ValidationRunOptions,
): Promise<ValidationRunResult> {
  if (options.task.validationCommands.length === 0) return { ok: true, results: [] };
  if (options.installDependencies) {
    const dependencies = await installDependencies(options);
    if (!dependencies.ok) return { ok: false, reason: dependencies.reason, results: [] };
  }

  const results: ValidationCommandResult[] = [];
  for (const command of options.task.validationCommands) {
    const result = await runCommand(command, [], {
      shell: true,
      cwd: options.workspacePath,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: 10 * 1024 * 1024,
      ...(options.environment
        ? { env: { ...options.environment }, inheritEnvironment: false, reapProcessGroupOnExit: true }
        : {}),
      ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.processIdentity && result.processCleanup === "unconfirmed") {
      quarantineTaskProcessIdentity(options.processIdentity);
    }
    results.push({
      command,
      status: result.status,
      stdout: output(result.stdout, options.redact),
      stderr: output(result.stderr, options.redact),
    });
    const ownsProcess = options.environment !== undefined || options.processIdentity !== undefined;
    if (result.processCleanup === "unconfirmed" && ownsProcess) {
      return {
        ok: false,
        reason: `validation command process cleanup could not be confirmed: ${command}`,
        results,
      };
    }
    if (result.status !== 0) {
      const detail = output(result.stderr || result.stdout, options.redact).trim();
      return {
        ok: false,
        reason: `validation command failed (exit ${String(result.status)}): ${command}${detail ? `\n${detail}` : ""}`,
        results,
      };
    }
  }
  return { ok: true, results };
}
