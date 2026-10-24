import { existsSync, readFileSync } from "node:fs";
import { chown, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { runCommand, extractModelFlags, canSelectAgentNatively, harnessProcessOptions } from "./run.ts";
import { harnessInvocationContext } from "./invocation-log.ts";
import type { AgentDescriptor, HarnessAdapter, TaskAttemptRequest, TaskResult } from "../types.ts";
import { inlinePersona } from "../request.ts";
import { executionPrompt } from "../task-execution.ts";

/**
 * OpenCode CLI harness adapter.
 *
 * Invokes `opencode run` per task, captures stdout/stderr, and returns a
 * structured TaskResult.
 *
 * Agent selection is native when possible: if the owning agent's file lives
 * under the project's `.opencode/agents/` directory, the adapter passes
 * `--agent <name>` so opencode loads the persona itself (the session shows the
 * forge agent rather than the default build agent) and the persona is not
 * inlined. For other harness roots (`.agents`, `.claude`, `.github`) opencode
 * cannot discover the agent files, so the persona is included in the repository
 * task's execution file instead (inline for text-only tasks).
 *
 * Expected CLI shapes:
 *   opencode run [--model <model-id>] [--agent <name>] "<short execution-file instruction>"
 *   opencode run [--model <model-id>] "<short execution-file instruction>"
 *
 * Set OPENCODE_BIN env var to override the opencode binary path.
 * Set OPENCODE_EXTRA_FLAGS env var to inject extra flags (e.g. "--no-stream").
 * `--auto` is passed by default so per-task tool permissions are auto-approved;
 * this adapter runs non-interactively (no user is present to approve prompts).
 *
 * The project directory is pinned by the child's spawn `cwd` (see `invoke`).
 * OpenCode v2 removed `run --dir` and added no replacement: `run` takes only
 * `message...` arguments, so a trailing path would be swallowed into the prompt
 * while the project stayed wherever the process was launched.
 *
 * `cwd` is necessary but not sufficient on its own: v2 resolves the project
 * from `process.env.PWD ?? process.cwd()`, so an inherited stale `PWD`
 * outranks the correct `cwd`. `runCommand` pins both, so they cannot disagree -
 * see ADR-059, which corrects the `PWD` claim in ADR-058.
 *
 * There is no engine-managed warm server. OpenCode v2 dropped `run --attach`,
 * so instead each `opencode run` connects to OpenCode's own background
 * service, which is warm by default (config, AGENTS.md, skills, and MCP
 * servers are already booted) while every run still gets a fresh, isolated
 * session in the project its `cwd` names. Pass `--standalone` via
 * OPENCODE_EXTRA_FLAGS to give a run its own private server instead.
 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly name = "opencode";
  readonly supportsConcurrency = true;
  readonly capabilities = ["text", "repository-tools"] as const;
  readonly defaultModel?: string;

  private readonly bin: string;
  private readonly extraFlags: string[];

  constructor() {
    this.bin = process.env["OPENCODE_BIN"] ?? "opencode";
    const extra = (process.env["OPENCODE_EXTRA_FLAGS"] ?? "").split(/\s+/).filter(Boolean);
    const parsed = extractModelFlags(extra);
    this.extraFlags = ["--auto", ...parsed.flags];
    this.defaultModel = parsed.model;
  }

  async invoke(request: TaskAttemptRequest): Promise<TaskResult> {
    const start = Date.now();
    const { agent, task, repoRoot } = request;
    const processOptions = harnessProcessOptions(request);
    const environment = processOptions.env ? { ...processOptions.env } : undefined;
    const authJson = environment?.OPENCODE_AUTH_JSON;
    if (authJson && environment) {
      delete environment.OPENCODE_AUTH_JSON;
      const imported = await this.importGrantedAuth(request, authJson, environment);
      if (imported) {
        request.isolation?.onProcessSettled?.(imported.processCleanup ?? "observed");
        return {
          success: false,
          outputFiles: [],
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
          errorMessage: imported.error,
          failureKind: "configuration",
        };
      }
    }

    // OpenCode model IDs are provider-qualified (for example,
    // `github-copilot/gpt-5.6-luna`); unlike Copilot, do not strip the prefix.
    const model = request.effectiveModel ?? this.defaultModel;
    const modelFlag = model ? ["--model", model] : [];
    const agentFlag = this.canSelectAgent(request) ? ["--agent", agent.name] : [];

    const prompt = executionPrompt(request, agentFlag.length === 0 ? inlinePersona(request) : "");
    const args = ["run", ...modelFlag, ...agentFlag, ...this.extraFlags, prompt];

    const result = await runCommand(this.bin, args, {
      // `opencode run` resolves its project from `process.env.PWD ??
      // process.cwd()` (read out of the v2.0.20 bundle), so `PWD` is what
      // actually decides and an inherited one outranks `cwd`. `runCommand`
      // sets `PWD` to this `cwd` for the child, so pinning `cwd` keeps a task
      // in its repository - or, in parallel mode, in its own sandbox worktree
      // - even when the engine process lives in a subdirectory such as the
      // engine's own package dir. Do not drop `cwd` thinking PWD covers it.
      cwd: repoRoot,
      timeoutMs: request.budget.timeoutMs,
      signal: request.signal,
      maxBufferBytes: 10 * 1024 * 1024,
      invocation: harnessInvocationContext(this.name, request),
      activity: request.logHarnessActivity === true,
      ...(request.log ? { log: request.log } : {}),
      ...processOptions,
      ...(environment ? { env: environment } : {}),
    });
    const durationMs = Date.now() - start;

    const stdout = result.stdout;
    const stderr = result.stderr;

    if (result.error) {
      return {
        success: false,
        outputFiles: [],
        stdout,
        stderr,
        durationMs,
        errorMessage: result.error,
        failureKind: result.failureKind,
      };
    }

    if (result.status !== 0) {
      return {
        success: false,
        outputFiles: [],
        stdout,
        stderr,
        durationMs,
        errorMessage: stderr || `${this.bin} exited with status ${result.status}`,
        failureKind: "retryable",
      };
    }

    const outputFiles = task.expectedOutputs.filter((path) =>
      existsSync(resolve(repoRoot, path)),
    );

    return {
      success: true,
      outputFiles,
      stdout,
      stderr: "",
      durationMs,
    };
  }

  /** True when opencode can select this agent natively; see `canSelectAgentNatively`. */
  private canSelectAgent(request: TaskAttemptRequest): boolean {
    return canSelectAgentNatively(request, ".opencode");
  }

  private async importGrantedAuth(
    request: TaskAttemptRequest,
    authJson: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<{ readonly error: string; readonly processCleanup?: "observed" | "unconfirmed" } | undefined> {
    let exported: unknown;
    try {
      exported = JSON.parse(authJson);
    } catch {
      return { error: "OPENCODE_AUTH_JSON must contain valid OpenCode exported credentials." };
    }
    if (!Array.isArray(exported) || exported.length !== 1) {
      return { error: "OPENCODE_AUTH_JSON must contain exactly one explicitly granted provider credential." };
    }
    const expectedProvider = exported[0] && typeof exported[0] === "object" && "integrationID" in exported[0]
      ? exported[0].integrationID
      : undefined;
    if (typeof expectedProvider !== "string" || !expectedProvider) {
      return { error: "OPENCODE_AUTH_JSON must contain one credential with a provider identifier." };
    }
    const dataHome = environment.XDG_DATA_HOME;
    const temporaryHome = environment.TMPDIR;
    if (!dataHome || !isAbsolute(dataHome) || !temporaryHome || !isAbsolute(temporaryHome)) {
      return { error: "OpenCode auth import requires isolated XDG_DATA_HOME and TMPDIR paths." };
    }

    const authFile = join(temporaryHome, `opencode-auth-${randomUUID()}.json`);
    await mkdir(temporaryHome, { recursive: true, mode: 0o700 });
    try {
      await writeFile(authFile, authJson, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (request.isolation?.processIdentity) {
        await chown(authFile, request.isolation.processIdentity.uid, request.isolation.processIdentity.gid);
      }
      const result = await runCommand(this.bin, ["auth", "import", "--standalone", authFile], {
        cwd: request.repoRoot,
        timeoutMs: Math.min(request.budget.timeoutMs, 30_000),
        maxBufferBytes: 1024 * 1024,
        env: environment,
        inheritEnvironment: false,
        reapProcessGroupOnExit: true,
        ...(request.isolation?.processIdentity ? { processIdentity: request.isolation.processIdentity } : {}),
        signal: request.signal,
      });
      if (result.error || result.status !== 0 || result.processCleanup === "unconfirmed") {
        return {
          error: "OpenCode could not import the explicitly granted provider credential into its isolated task home.",
          ...(result.processCleanup ? { processCleanup: result.processCleanup } : {}),
        };
      }
      const verification = await runCommand(this.bin, ["auth", "export", "--standalone"], {
        cwd: request.repoRoot,
        timeoutMs: Math.min(request.budget.timeoutMs, 30_000),
        maxBufferBytes: 1024 * 1024,
        env: environment,
        inheritEnvironment: false,
        reapProcessGroupOnExit: true,
        ...(request.isolation?.processIdentity ? { processIdentity: request.isolation.processIdentity } : {}),
        signal: request.signal,
      });
      if (verification.error || verification.status !== 0 || verification.processCleanup === "unconfirmed") {
        return {
          error: "OpenCode did not verify the provider credential in its isolated task home.",
          ...(verification.processCleanup ? { processCleanup: verification.processCleanup } : {}),
        };
      }
      let stored: unknown;
      try {
        stored = JSON.parse(verification.stdout);
      } catch {
        return { error: "OpenCode returned an invalid credential verification result.", processCleanup: "observed" };
      }
      if (
        !Array.isArray(stored)
        || stored.length !== 1
        || !stored[0]
        || typeof stored[0] !== "object"
        || !("integrationID" in stored[0])
        || stored[0].integrationID !== expectedProvider
      ) {
        return {
          error: "OpenCode did not store exactly the explicitly granted provider credential.",
          processCleanup: verification.processCleanup ?? "observed",
        };
      }
      return undefined;
    } finally {
      await rm(authFile, { force: true });
    }
  }
}

export function resolveAgentForTask(
  agents: AgentDescriptor[],
  ownerName: string | undefined,
): AgentDescriptor | undefined {
  if (!ownerName) return undefined;
  return agents.find((a) => a.name === ownerName);
}

export function loadAgentFile(agentPath: string): string {
  return existsSync(agentPath) ? readFileSync(agentPath, "utf8") : "";
}
