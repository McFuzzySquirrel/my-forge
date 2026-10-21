import spawn from "cross-spawn";
import { execFile, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import readCmdShim from "read-cmd-shim";
import which from "which";
import type { ProcessCleanup } from "../../contract/v1/execution-ownership.ts";
import type { ProcessIdentityV1, TaskAttemptRequest, TaskFailureKind } from "../types.ts";
import {
  ActivityLineBuffer,
  formatActivityLine,
  formatCompletionLine,
  formatInvocationLine,
  type HarnessInvocationContext,
} from "./invocation-log.ts";

const CLEANUP_TIMEOUT_MS = 1000;

/**
 * Process-group watchdog for owned harness invocations (POSIX only).
 *
 * The watchdog leads the harness's process group and launches the harness
 * inside it. It holds an IPC channel to the worker and stays alive after the
 * harness exits until the worker reaps the whole group. When the worker dies at
 * any point (crash, SIGKILL, OOM), the kernel closes the channel; on
 * `disconnect` the watchdog kills its own group, so no owned descendant outlives
 * the worker. It also kills the group at an absolute hard deadline, which
 * bounds the tree even when the worker is alive but unresponsive.
 *
 * argv: deadlineAtMs, shell flag ("1"/"0"), bin, ...args.
 */
const WATCHDOG_SOURCE = `"use strict";
const { spawn } = require("node:child_process");
const [deadlineText, shellFlag, bin, ...args] = process.argv.slice(1);
const killGroup = () => {
  try { process.kill(-process.pid, "SIGKILL"); } catch {}
  process.exit(137);
};
if (!process.connected) killGroup();
process.on("disconnect", killGroup);
setTimeout(killGroup, Math.max(0, Number(deadlineText) - Date.now()));
const env = { ...process.env };
delete env.NODE_CHANNEL_FD;
delete env.NODE_CHANNEL_SERIALIZATION_MODE;
const spawnFailed = (error) => {
  process.send({ spawnError: String((error && error.message) || error) }, () => process.exit(127));
};
try {
  const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"], env, shell: shellFlag === "1" });
  child.on("error", spawnFailed);
  child.on("exit", (code, signal) => process.send({ exit: { code, signal } }));
} catch (error) {
  spawnFailed(error);
}
`;

interface WatchdogMessage {
  spawnError?: string;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}

export interface RunCommandOptions {
  cwd: string;
  shell?: boolean;
  timeoutMs: number;
  maxBufferBytes: number;
  /**
   * Extra environment variables merged over `process.env`.
   *
   * A child is never handed a `PWD` that disagrees with `cwd`; see
   * `childEnv`. Passing `PWD` here is therefore pointless: `cwd` wins.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When false, the child receives only `env` (plus the corrected `PWD`), not
   * the worker's own environment. Defaults to true for legacy callers.
   */
  inheritEnvironment?: boolean;
  /**
   * When true on POSIX, the command runs under the process-group watchdog
   * (`WATCHDOG_SOURCE`): descendants left in the group after a normal exit are
   * killed, and the group also dies with the worker or at the hard deadline, so
   * no owned subprocess outlives the invocation. Without a process-group
   * primitive (Windows), cleanup is reported unconfirmed.
   */
  reapProcessGroupOnExit?: boolean;
  /** Drop privileges before launching a supervised task process. */
  processIdentity?: ProcessIdentityV1;
  /** Receives `processCleanup` when a started process settles. */
  onProcessSettled?: (cleanup: ProcessCleanup) => void;
  signal?: AbortSignal;
  /** When present, the invocation (and effective invocation) is logged before launch. */
  invocation?: HarnessInvocationContext;
  /** When true, mirror stdout/stderr into the log as it arrives. Off by default. */
  activity?: boolean;
  /** Log sink; defaults to `console.log` so lines reach docs/engine-run.log. */
  log?: (line: string) => void;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when the process was killed or failed to start. */
  status: number | null;
  /** Human-readable failure reason (spawn error, timeout, or buffer overflow). */
  error?: string;
  failureKind?: TaskFailureKind;
  /**
   * Whether termination of the owned process tree was observed. `unconfirmed`
   * means a kill timed out or failed, or descendants could not be reaped.
   * Absent when no process was started.
   */
  processCleanup?: ProcessCleanup;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the environment a child is launched with.
 *
 * `cwd` alone is not enough, because a child that trusts `$PWD` resolves its
 * project from the *inherited* `PWD` and ignores the working directory it was
 * given. OpenCode v2 is exactly that: its `run` handler computes
 * `process.env.PWD ?? process.cwd()`, so a stale `PWD` inherited from the shell
 * that started the engine outranks the correct `cwd` and every task runs against
 * the wrong project (ADR-059). The engine is normally launched from its own
 * package directory, so that stale `PWD` names a different project entirely.
 *
 * So a child is only ever launched with `PWD` equal to its `cwd`: `cwd` fixes
 * the filesystem, `PWD` is corrected to match it, and the two cannot disagree.
 */
function childEnv(cwd: string, extra?: NodeJS.ProcessEnv, inherit = true): NodeJS.ProcessEnv {
  return { ...(inherit ? process.env : {}), ...extra, PWD: resolvePath(cwd) };
}

/**
 * Runs a command, capturing stdout/stderr asynchronously.
 *
 * Uses `cross-spawn` so npm-installed CLIs (opencode, copilot, claude), which
 * are `.cmd`/`.bat` shims on Windows, launch correctly. Unlike `spawnSync`
 * (which blocks the event loop), this yields while the child runs, so the
 * engine can emit heartbeat output during long-running tasks.
 */
export function runCommand(
  bin: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<RunCommandResult> {
  if (opts.signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", status: null, error: "Task cancelled", failureKind: "cancelled" });
  const log = opts.log ?? ((line: string) => console.log(line));
  const ctx = opts.invocation;
  const requestedBin = bin;
  const requestedArgs = [...args];
  if (ctx) log(formatInvocationLine(ctx, requestedBin, requestedArgs, "requested"));
  return new Promise((resolve) => {
    if (process.platform === "win32" && !opts.shell) {
      try {
        const command = which.sync(bin, { path: opts.env?.PATH ?? process.env.PATH });
        if (/\.cmd$/i.test(command)) {
          const script = resolvePath(dirname(command), readCmdShim.sync(command));
          if (/\.[cm]?js$/i.test(script) && /^#![^\r\n]*\bnode\b/.test(readFileSync(script, "utf8"))) {
            const localNode = resolvePath(dirname(command), "node.exe");
            bin = existsSync(localNode) ? localNode : process.execPath;
            args = [script, ...args];
          }
        }
      } catch {
        // Non-npm launchers retain cross-spawn's executable resolution.
      }
    }
    // Record the effective invocation when launcher resolution rewrote it.
    if (ctx && (bin !== requestedBin || args.length !== requestedArgs.length || args.some((arg, index) => arg !== requestedArgs[index]))) {
      log(formatInvocationLine(ctx, bin, args, "effective"));
    }
    const activity = ctx && opts.activity
      ? {
          stdout: new ActivityLineBuffer((line) => log(formatActivityLine(ctx, "stdout", line))),
          stderr: new ActivityLineBuffer((line) => log(formatActivityLine(ctx, "stderr", line))),
        }
      : undefined;
    // A dedicated POSIX process group lets cancellation include descendants
    // inheriting the output pipes. This remains attached: no unref during work.
    // Owned (reaped) invocations run under the process-group watchdog so the
    // group also dies with the worker or at the hard deadline.
    const watchdogDeadlineAt = opts.reapProcessGroupOnExit && process.platform !== "win32"
      ? Date.now() + opts.timeoutMs + CLEANUP_TIMEOUT_MS
      : undefined;
    const identityArgs = opts.processIdentity
      ? ["--reuid", String(opts.processIdentity.uid), "--regid", String(opts.processIdentity.gid), "--clear-groups", "--"]
      : [];
    const targetBin = opts.shell ? "/bin/sh" : bin;
    const targetArgs = opts.shell
      ? ["-c", [bin, ...args.map(shellQuote)].join(" ")]
      : args;
    if (opts.processIdentity && process.platform === "win32") {
      resolve({ stdout: "", stderr: "", status: null, error: "Per-task POSIX identities are unavailable on Windows." });
      return;
    }
    const child = watchdogDeadlineAt === undefined
      ? spawn(opts.processIdentity ? "setpriv" : bin, opts.processIdentity ? [...identityArgs, targetBin, ...targetArgs] : args, {
          cwd: opts.cwd, env: childEnv(opts.cwd, opts.env, opts.inheritEnvironment ?? true), stdio: ["ignore", "pipe", "pipe"],
          shell: opts.processIdentity ? false : opts.shell,
          detached: process.platform !== "win32", windowsHide: true,
        })
      : spawnProcess(opts.processIdentity ? "setpriv" : process.execPath, [
          ...identityArgs,
          ...(opts.processIdentity ? [process.execPath] : []),
          "-e", WATCHDOG_SOURCE, "--", String(watchdogDeadlineAt), opts.shell ? "1" : "0", bin, ...args,
        ], {
          cwd: opts.cwd, env: childEnv(opts.cwd, opts.env, opts.inheritEnvironment ?? true), stdio: ["ignore", "pipe", "pipe", "ipc"],
          detached: true, windowsHide: true,
        });

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: { error: string; failureKind: TaskFailureKind } | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let treeKiller: ChildProcess | undefined;
    let terminating = false;
    let terminationFinished = false;
    let closed = false;
    let cleanup: ProcessCleanup | undefined;

    const settle = (status: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      opts.signal?.removeEventListener("abort", cancel);
      activity?.stdout.flush();
      activity?.stderr.flush();
      const resolvedStatus = terminating ? null : status;
      if (ctx) {
        log(formatCompletionLine(ctx, {
          status: resolvedStatus,
          error: failure?.error ?? error,
          failureKind: failure?.failureKind,
          durationMs: Date.now() - startedAt,
        }));
      }

      // A normal exit only proves descendants are gone when the group was reaped.
      const processCleanup = child.pid
        ? cleanup ?? (terminating || opts.reapProcessGroupOnExit ? "observed" : "unconfirmed")
        : undefined;
      if (processCleanup) opts.onProcessSettled?.(processCleanup);
      resolve({
        stdout, stderr, status: resolvedStatus, error: failure?.error ?? error, failureKind: failure?.failureKind,
        ...(processCleanup ? { processCleanup } : {}),
      });
    };

    const terminate = (error: string, failureKind: TaskFailureKind) => {
      if (settled || failure) return;
      failure = { error, failureKind };
      terminating = true;
      const cleanupFailed = (reason: string) => {
        if (settled) return;
        cleanup = "unconfirmed";
        failure = { error: `${error}; process-tree cleanup failed: ${reason}`, failureKind: "exception" };
      };
      cleanupTimer = setTimeout(() => {
        cleanupFailed(`exceeded ${CLEANUP_TIMEOUT_MS}ms; closing inherited output pipes`);
        treeKiller?.kill("SIGKILL");
        treeKiller?.unref();
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          cleanupFailed(`exceeded ${CLEANUP_TIMEOUT_MS}ms; direct-child termination also failed: ${String(killError)}`);
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle(null);
      }, CLEANUP_TIMEOUT_MS);
      const finished = () => {
        terminationFinished = true;
        if (closed) settle(null);
      };
      if (!child.pid) {
        finished();
      } else if (process.platform === "win32") {
        // taskkill targets this invocation's PID tree, including .cmd wrappers.
        treeKiller = execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, timeout: CLEANUP_TIMEOUT_MS, maxBuffer: 64 * 1024,
        }, (killError, _stdout, killStderr) => {
          if (killError) cleanupFailed(killStderr.trim() || killError.message);
          finished();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (killError) {
          if (!(killError instanceof Error && "code" in killError && killError.code === "ESRCH")) {
            cleanupFailed(killError instanceof Error ? killError.message : String(killError));
          }
        }
        finished();
      }
    };
    const cancel = () => terminate("Task cancelled", "cancelled");
    opts.signal?.addEventListener("abort", cancel, { once: true });
    if (opts.signal?.aborted) cancel();

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      activity?.[target].write(chunk);
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length + text.length > opts.maxBufferBytes) {
          terminate(`stdout exceeded ${opts.maxBufferBytes} bytes`, "exception");
          return;
        }
        stdout += text;
      } else {
        if (stderr.length + text.length > opts.maxBufferBytes) {
          terminate(`stderr exceeded ${opts.maxBufferBytes} bytes`, "exception");
          return;
        }
        stderr += text;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    const timer = setTimeout(() => {
      terminate(`timed out after ${opts.timeoutMs}ms`, "timeout");
    }, opts.timeoutMs);

    child.on("error", (err) => {
      failure ??= { error: err.message, failureKind: "configuration" };
    });
    // Watchdog mode: the harness's own exit arrives over IPC while the watchdog
    // still anchors the group, so reaping happens before the group can be orphaned.
    let harnessExit: WatchdogMessage["exit"];
    child.on("message", (message: WatchdogMessage) => {
      if (message.spawnError !== undefined) {
        failure ??= { error: message.spawnError, failureKind: "configuration" };
      } else if (message.exit && !harnessExit) {
        harnessExit = message.exit;
        if (!terminating && child.pid) cleanup = reapProcessGroup(child.pid);
      }
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (watchdogDeadlineAt !== undefined) {
        if (harnessExit) {
          code = harnessExit.code;
        } else if (!terminating && !failure) {
          // The watchdog killed the group without the worker asking: the worker
          // missed its own timeout, so the hard deadline fired.
          failure = Date.now() >= watchdogDeadlineAt
            ? { error: `timed out after ${opts.timeoutMs}ms (watchdog hard deadline)`, failureKind: "timeout" }
            : { error: `harness watchdog exited unexpectedly (${signal ?? `code ${code}`})`, failureKind: "exception" };
          code = null;
          if (child.pid) cleanup = reapProcessGroup(child.pid);
        }
      } else if (!terminating && opts.reapProcessGroupOnExit && child.pid) {
        cleanup = reapProcessGroup(child.pid);
      }
      if (!terminating || terminationFinished) settle(code);
    });
  });
}

/** Kills any descendant still in an exited leader's process group. */
function reapProcessGroup(pid: number): ProcessCleanup {
  if (process.platform === "win32") return "unconfirmed";
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return "observed";
    return "unconfirmed";
  }
  return "observed";
}

/**
 * Process options an adapter passes to `runCommand` for an isolated request:
 * a complete, non-inherited environment and reaping of leftover descendants.
 * Requests without isolation keep the legacy inherited environment.
 */
export function harnessProcessOptions(
  request: Pick<TaskAttemptRequest, "isolation">,
): Pick<RunCommandOptions, "env" | "inheritEnvironment" | "reapProcessGroupOnExit" | "onProcessSettled" | "processIdentity"> {
  const isolation = request.isolation;
  if (!isolation) return {};
  return {
    env: { ...isolation.environment },
    inheritEnvironment: false,
    reapProcessGroupOnExit: true,
    ...(isolation.processIdentity ? { processIdentity: isolation.processIdentity } : {}),
    ...(isolation.onProcessSettled ? { onProcessSettled: isolation.onProcessSettled } : {}),
  };
}

/** Extra model flags are transport defaults, never later argv overrides. */
export function extractModelFlags(args: string[]): { flags: string[]; model?: string } {
  const flags: string[] = [];
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model" || arg === "-m" || arg.startsWith("--model=")) {
      const value = arg.startsWith("--model=") ? arg.slice("--model=".length) : args[++index];
      if (!value || value.startsWith("-")) throw new Error("Extra model flag requires a model ID.");
      if (model !== undefined && model !== value) throw new Error("Conflicting extra model flags; provide one transport default.");
      model = value;
    } else flags.push(arg);
  }
  return { flags, model };
}

/** Model IDs may carry a provider prefix (`anthropic/claude-sonnet-5`); CLIs want the bare ID. */
export function stripProviderPrefix(model: string): string {
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

/**
 * True when the request's agent can be selected natively by a harness whose
 * agent directory is `<root>/agents/`: the agent has a name, its file lives
 * under that directory relative to repoRoot, and FORGE_ENGINE_NATIVE_AGENT is
 * not "0" (which forces the inline-persona fallback for every harness).
 */
export function canSelectAgentNatively(
  request: Pick<TaskAttemptRequest, "agent" | "repoRoot">,
  root: ".github" | ".opencode" | ".claude",
): boolean {
  const { agent, repoRoot } = request;
  if (process.env["FORGE_ENGINE_NATIVE_AGENT"] === "0") return false;
  if (!agent.name) return false;
  const parts = relative(repoRoot, agent.path).split(/[\\/]/);
  return parts[0] === root && parts[1] === "agents" && parts.length > 2;
}
