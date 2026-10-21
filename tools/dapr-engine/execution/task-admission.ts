import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalDigest } from "../contract/v1/index.ts";
import {
  captureWorktree,
  diffWorktree,
  isTrivialOutput,
  runTaskValidation,
  type WorktreeSnapshot,
} from "./verify.ts";
import { readTaskHandoff, type TaskHandoff } from "./task-result.ts";
import type { ManifestTask, ProcessIdentityV1, TaskGateResult, TaskResult } from "./types.ts";

export interface TaskAdmissionOptions {
  readonly task: ManifestTask;
  readonly result: TaskResult;
  readonly repoRoot: string;
  readonly baseline: WorktreeSnapshot | null;
  readonly allowNoop: boolean;
  readonly timeoutMs: number;
  /** Isolated environment for validation commands; see `runTaskValidation`. */
  readonly validationEnvironment?: Readonly<Record<string, string>>;
  readonly validationProcessIdentity?: ProcessIdentityV1;
}

export type TaskAdmissionResult =
  | {
      readonly ok: true;
      readonly handoff: TaskHandoff;
      readonly handoffDigest: `sha256:${string}`;
      readonly outputFiles: readonly string[];
      readonly validationCommands: readonly string[];
      readonly gates: readonly TaskGateResult[];
    }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly failureCode: string;
      readonly reason: string;
      readonly gates: readonly TaskGateResult[];
    };

function gate(
  name: TaskGateResult["gate"],
  status: TaskGateResult["status"],
  reason?: string,
  evidence?: string[],
): TaskGateResult {
  return {
    gate: name,
    status,
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function reject(
  failureCode: string,
  reason: string,
  gates: TaskGateResult[],
  retryable = true,
): TaskAdmissionResult {
  return { ok: false, retryable, failureCode, reason, gates };
}

function boundedReason(reason: string): string {
  const maxLength = 4_000;
  return reason.length > maxLength ? `${reason.slice(0, maxLength)}\n[diagnostic truncated]` : reason;
}

function resolveExpectedOutput(repoRoot: string, output: string): string | undefined {
  if (!output || isAbsolute(output)) return undefined;
  const absolute = resolve(realpathSync(repoRoot), output);
  const pathFromRoot = relative(realpathSync(repoRoot), absolute);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return undefined;
  }
  return absolute;
}

function expectedOutputFiles(
  repoRoot: string,
  outputs: readonly string[],
): { readonly missing: string[]; readonly invalid?: string } {
  const missing: string[] = [];
  const root = realpathSync(repoRoot);
  for (const output of outputs) {
    const path = resolveExpectedOutput(repoRoot, output);
    if (!path) {
      return { missing: [], invalid: output };
    }
    try {
      if (!existsSync(path)) {
        missing.push(output);
        continue;
      }
      const resolved = realpathSync(path);
      const resolvedFromRoot = relative(root, resolved);
      if (resolvedFromRoot === ".." || resolvedFromRoot.startsWith(`..${sep}`) || isAbsolute(resolvedFromRoot)) {
        return { missing: [], invalid: output };
      }
      if (!lstatSync(path).isFile()) missing.push(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        missing.push(output);
      } else {
        throw error;
      }
    }
  }
  return { missing };
}

export async function admitTaskResult(options: TaskAdmissionOptions): Promise<TaskAdmissionResult> {
  const gates: TaskGateResult[] = [];
  if (!options.result.success) {
    const reason = options.result.errorMessage || options.result.failureKind || "Harness execution failed.";
    const retryable = options.result.failureKind !== "configuration" && options.result.failureKind !== "cancelled";
    return reject("harness-failed", reason, [
      gate("harness", "failed", reason),
      gate("outputs", "skipped"),
      gate("handoff", "skipped"),
      gate("requirements", "skipped"),
      gate("validation", "skipped"),
    ], retryable);
  }
  gates.push(gate("harness", "passed", undefined, ["harness exited successfully"]));

  const outputCheck = expectedOutputFiles(options.repoRoot, options.task.expectedOutputs);
  if (outputCheck.invalid !== undefined) {
    return reject("invalid-expected-output", "Expected output paths must be repository-relative files.", [
      ...gates,
      gate("outputs", "failed", `Expected output path is absolute or escapes the repository: ${outputCheck.invalid}`),
      gate("handoff", "skipped"),
      gate("requirements", "skipped"),
      gate("validation", "skipped"),
    ], false);
  }
  if (outputCheck.missing.length > 0) {
    return reject("expected-outputs-missing", `Expected outputs are missing or not regular files: ${outputCheck.missing.join(", ")}`, [
      ...gates,
      gate("outputs", "failed", `Missing outputs: ${outputCheck.missing.join(", ")}`),
      gate("handoff", "skipped"),
      gate("requirements", "skipped"),
      gate("validation", "skipped"),
    ]);
  }

  const parsed = readTaskHandoff(options.result.stdout);
  if (!parsed.handoff) {
    const reason = parsed.error ?? "Structured task outcome is invalid.";
    return reject("invalid-handoff", reason, [
      ...gates,
      gate("outputs", "passed", undefined, options.task.expectedOutputs),
      gate("handoff", "failed", reason),
      gate("requirements", "skipped"),
      gate("validation", "skipped"),
    ]);
  }
  const handoff = parsed.handoff;
  if (handoff.unresolved.length > 0) {
    const reason = `Blocking requirements remain unresolved: ${handoff.unresolved.join("; ")}`;
    return reject("unresolved-requirements", reason, [
      ...gates,
      gate("outputs", "passed", undefined, options.task.expectedOutputs),
      gate("handoff", "passed", undefined, [handoff.summary]),
      gate("requirements", "failed", reason, handoff.unresolved),
      gate("validation", "skipped"),
    ]);
  }

  const changedFiles = options.task.expectedOutputs.length > 0
    ? []
    : diffWorktree(options.baseline, await captureWorktree(options.repoRoot));
  if (options.task.expectedOutputs.length === 0 && !options.allowNoop
    && changedFiles.length === 0 && isTrivialOutput(handoff.summary)) {
    const reason = "Task produced no changed files and its structured summary is not substantive.";
    return reject("no-op", reason, [
      ...gates,
      gate("outputs", "failed", reason),
      gate("handoff", "passed", undefined, [handoff.summary]),
      gate("requirements", "passed", undefined, ["unresolved=[]"]),
      gate("validation", "skipped"),
    ]);
  }
  const outputFiles = [...new Set([...options.task.expectedOutputs, ...changedFiles])];
  gates.push(gate(
    "outputs",
    "passed",
    undefined,
    outputFiles.length > 0 ? outputFiles : [options.allowNoop ? "no-op explicitly allowed" : "substantive structured summary"],
  ));
  gates.push(gate("handoff", "passed", undefined, [handoff.summary]));
  gates.push(gate("requirements", "passed", undefined, ["unresolved=[]"]));

  const validation = await runTaskValidation(
    options.task,
    options.repoRoot,
    options.timeoutMs,
    options.validationEnvironment,
    options.validationProcessIdentity,
  );
  if (!validation.ok) {
    const reason = boundedReason(validation.reason ?? "A mandatory validation command failed.");
    return reject("validation-failed", reason, [
      ...gates,
      gate("validation", "failed", reason),
    ]);
  }
  gates.push(gate(
    "validation",
    "passed",
    undefined,
    options.task.validationCommands.length > 0
      ? [...options.task.validationCommands]
      : ["no validation commands declared"],
  ));

  return {
    ok: true,
    handoff,
    handoffDigest: canonicalDigest(handoff),
    outputFiles,
    validationCommands: [...options.task.validationCommands],
    gates,
  };
}
