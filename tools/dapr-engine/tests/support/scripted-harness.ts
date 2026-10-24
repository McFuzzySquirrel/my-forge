import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { harnessProcessOptions, runCommand } from "../../execution/harness/run.ts";
import type { HarnessAdapter, TaskAttemptRequest, TaskResult } from "../../execution/types.ts";

export interface ScriptedAttempt {
  /** Repository-relative files to write. */
  readonly files?: Readonly<Record<string, string>>;
  /** Files to write inside the harness's isolated home, relative to HOME. */
  readonly homeFiles?: Readonly<Record<string, string>>;
  readonly summary?: string;
  readonly unresolved?: readonly string[];
  /** Simulate a failing harness exit instead of producing a result. */
  readonly fail?: string;
  readonly delayMs?: number;
}

export interface ScriptedInvocation {
  readonly taskId: string;
  readonly attempt: number;
  readonly repoRoot: string;
  readonly agentPath: string;
  readonly budgetMs: number;
  readonly instructions: string;
  /** Variable names visible to an isolated child process (values are never recorded). */
  readonly childEnvironment: readonly string[];
  readonly childHome?: string;
}

/**
 * Deterministic stub harness for composed execution tests. Each invocation runs
 * a real child process under the request's isolation policy (to observe the
 * environment it would receive) and then applies the scripted repository change
 * and structured `forge-result` handoff.
 */
export class ScriptedHarness implements HarnessAdapter {
  readonly name = "scripted-stub";
  readonly supportsConcurrency = true;
  readonly capabilities = ["text", "repository-tools"] as const;
  readonly invocations: ScriptedInvocation[] = [];

  constructor(private readonly script: (request: TaskAttemptRequest) => ScriptedAttempt) {}

  async invoke(request: TaskAttemptRequest): Promise<TaskResult> {
    const started = Date.now();
    const probe = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify({names:Object.keys(process.env).sort(),home:process.env.HOME}))"], {
      cwd: request.repoRoot,
      timeoutMs: request.budget.timeoutMs,
      signal: request.signal,
      maxBufferBytes: 1024 * 1024,
      ...harnessProcessOptions(request),
    });
    const observed = probe.status === 0 ? JSON.parse(probe.stdout) as { names: string[]; home?: string } : { names: [] };
    this.invocations.push({
      taskId: request.task.id,
      attempt: request.attempt.number,
      repoRoot: request.repoRoot,
      agentPath: request.agent.path,
      budgetMs: request.budget.timeoutMs,
      instructions: request.instructions,
      childEnvironment: observed.names,
      ...(observed.home ? { childHome: observed.home } : {}),
    });

    const attempt = this.script(request);
    if (attempt.delayMs) await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
    if (attempt.fail) {
      return {
        success: false,
        outputFiles: [],
        stdout: "",
        stderr: attempt.fail,
        durationMs: Date.now() - started,
        errorMessage: attempt.fail,
        failureKind: "retryable",
      };
    }
    for (const [path, content] of Object.entries(attempt.files ?? {})) {
      const absolute = join(request.repoRoot, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const home = request.isolation?.environment?.HOME;
    if (attempt.homeFiles && home) {
      for (const [path, content] of Object.entries(attempt.homeFiles)) {
        const absolute = join(home, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }
    }
    const report = { summary: attempt.summary ?? `Completed ${request.task.id}.`, unresolved: [...(attempt.unresolved ?? [])] };
    return {
      success: true,
      outputFiles: Object.keys(attempt.files ?? {}),
      stdout: `${request.task.id} done\n\`\`\`forge-result\n${JSON.stringify(report)}\n\`\`\`\n`,
      stderr: "",
      durationMs: Date.now() - started,
    };
  }
}
