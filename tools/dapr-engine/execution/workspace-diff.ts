import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { sha256Digest } from "../contract/v1/index.ts";
import type { HarnessRunnerWorkspaceDeltaV1 } from "./runner-contract.ts";

const execFileAsync = promisify(execFile);
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const DEFAULT_MAX_WORKSPACE_DELTA_BYTES = 16 * 1024 * 1024;

interface GitOptions {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly inheritEnvironment?: boolean;
}

/**
 * Git refuses to inspect a repository owned by another UID. Task-isolated
 * workspaces are intentionally chowned to the task identity while the service
 * remains root, so every service-side git command must trust its workspace.
 */
function safeDirectory(cwd: string): string[] {
  return ["-c", `safe.directory=${cwd}`];
}

async function runGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", [...safeDirectory(cwd), ...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.env ? {
      env: options.inheritEnvironment === false ? options.env : { ...process.env, ...options.env },
    } : {}),
  });
  return stdout;
}

async function gitText(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await runGit(cwd, args, options)).toString("utf8").trim();
}

async function assertBaseRevision(
  workspacePath: string,
  baseRevision: string,
  options: GitOptions = {},
  allowDescendant = false,
): Promise<void> {
  if (!isAbsolute(workspacePath)) throw new TypeError("Workspace path must be absolute.");
  if (!GIT_REVISION_PATTERN.test(baseRevision)) throw new TypeError("Base revision must be a full Git object ID.");
  const head = await gitText(workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  if (head === baseRevision) return;
  if (allowDescendant) {
    try {
      await runGit(workspacePath, ["merge-base", "--is-ancestor", baseRevision, head], options);
      return;
    } catch {
      // Fall through to the rejection below.
    }
  }
  throw new Error("Workspace HEAD does not match the accepted base revision.");
}

/** Creates a detached, remote-free workspace from a registered local repository. */
export async function cloneRepositoryAtRevision(
  repositoryPath: string,
  workspacePath: string,
  baseRevision: string,
  options: GitOptions = {},
): Promise<void> {
  if (!isAbsolute(repositoryPath) || !isAbsolute(workspacePath)) {
    throw new TypeError("Repository and workspace paths must be absolute.");
  }
  if (!GIT_REVISION_PATTERN.test(baseRevision)) {
    throw new TypeError("Base revision must be a full Git object ID.");
  }
  await execFileAsync("git", [
    ...safeDirectory(repositoryPath),
    "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--",
    repositoryPath, workspacePath,
  ], {
    cwd: dirname(workspacePath),
    encoding: "buffer",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.env ? {
      env: options.inheritEnvironment === false ? options.env : { ...process.env, ...options.env },
    } : {}),
  });
  await runGit(workspacePath, ["checkout", "--quiet", "--detach", baseRevision], options);
  await runGit(workspacePath, ["remote", "remove", "origin"], options);
}

export async function captureWorkspaceDelta(
  workspacePath: string,
  baseRevision: string,
  options: GitOptions & { readonly maxBytes?: number } = {},
): Promise<HarnessRunnerWorkspaceDeltaV1> {
  // A harness may commit its work in the disposable clone. Accept a HEAD that
  // descends from the base so the commit is captured in the delta instead of
  // rejecting an otherwise successful attempt.
  await assertBaseRevision(workspacePath, baseRevision, options, true);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_WORKSPACE_DELTA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Maximum workspace delta size must be a non-negative safe integer.");
  }

  const scratch = await mkdtemp(join(tmpdir(), "myforge-workspace-diff-"));
  try {
    const index = join(scratch, "index");
    const baseEnvironment = options.env
      ? options.inheritEnvironment === false ? options.env : { ...process.env, ...options.env }
      : process.env;
    const gitOptions: GitOptions = {
      ...options,
      env: { ...baseEnvironment, GIT_INDEX_FILE: index },
      inheritEnvironment: false,
    };
    await gitText(workspacePath, ["read-tree", baseRevision], gitOptions);
    await gitText(workspacePath, ["add", "--all", "--", "."], gitOptions);
    const diff = await runGit(
      workspacePath,
      ["diff", "--binary", "--cached", "--no-ext-diff", "--no-color", baseRevision],
      gitOptions,
    );
    if (diff.byteLength > maxBytes) {
      throw new RangeError(`Workspace delta exceeds ${maxBytes} bytes.`);
    }
    return {
      format: "git-binary-diff-v1",
      baseRevision,
      digest: sha256Digest(diff),
      contentBase64: diff.toString("base64"),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function applyWorkspaceDelta(
  workspacePath: string,
  delta: HarnessRunnerWorkspaceDeltaV1,
  options: GitOptions & { readonly maxBytes?: number } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_WORKSPACE_DELTA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Maximum workspace delta size must be a non-negative safe integer.");
  }
  if (delta.format !== "git-binary-diff-v1"
    || !GIT_REVISION_PATTERN.test(delta.baseRevision)
    || !/^sha256:[0-9a-f]{64}$/.test(delta.digest)
    || !isAbsolute(workspacePath)) {
    throw new TypeError("Workspace delta metadata is invalid.");
  }
  if (delta.contentBase64.length > Math.ceil(maxBytes / 3) * 4) {
    throw new RangeError(`Workspace delta exceeds ${maxBytes} bytes.`);
  }

  const bytes = Buffer.from(delta.contentBase64, "base64");
  if (bytes.toString("base64") !== delta.contentBase64) {
    throw new TypeError("Workspace delta is not canonical base64.");
  }
  if (bytes.byteLength > maxBytes) throw new RangeError(`Workspace delta exceeds ${maxBytes} bytes.`);
  if (sha256Digest(bytes) !== delta.digest) throw new Error("Workspace delta digest does not match its content.");
  await assertBaseRevision(workspacePath, delta.baseRevision, options);
  if (bytes.byteLength === 0) return;

  const scratch = await mkdtemp(join(tmpdir(), "myforge-workspace-apply-"));
  try {
    const patchPath = join(scratch, "workspace.patch");
    await writeFile(patchPath, bytes, { mode: 0o600 });
    await runGit(workspacePath, ["apply", "--check", "--binary", patchPath], options);
    await runGit(workspacePath, ["apply", "--binary", patchPath], options);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
