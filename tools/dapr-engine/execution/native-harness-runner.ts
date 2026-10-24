import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { remapAgentPath } from "./agent-path.ts";
import { inlinePersona } from "./request.ts";
import {
  DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
  captureWorkspaceDelta,
  cloneRepositoryAtRevision,
} from "./workspace-diff.ts";
import type {
  HarnessRunner,
  HarnessRunnerRequestV1,
  HarnessRunnerResultV1,
  HarnessRunnerValidationV1,
} from "./runner-contract.ts";
import { parseHarnessRunnerRequest } from "./runner-contract.ts";
import { executionPrompt } from "./task-execution.ts";
import { runValidationCommands } from "./validation.ts";
import { readTaskHandoff } from "./task-result.ts";
import type {
  HarnessAdapter,
  HarnessProcessIsolation,
  TaskAttemptRequest,
} from "./types.ts";

const RUNTIME_SECRET_PATTERN = /^(?:MYFORGE_|DAPR_)/;
const RUNTIME_SECRET_NAMES = new Set([
  "APP_DB_PASSWORD",
  "POSTGRES_PASSWORD",
]);
const SENSITIVE_ENV_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;

function redactSecretValues(value: string, environment: Readonly<Record<string, string>>): string {
  let redacted = value;
  const secretValues = Object.entries(environment)
    .filter(([name, secret]) => SENSITIVE_ENV_NAME.test(name) && secret.length >= 8)
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of secretValues) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted]");
}

function sanitizeTaskResult(
  result: Awaited<ReturnType<HarnessAdapter["invoke"]>>,
  environment: Readonly<Record<string, string>>,
): typeof result {
  const handoff = readTaskHandoff(result.stdout).handoff;
  const stdout = handoff
    ? `\`\`\`forge-result\n${JSON.stringify(handoff)}\n\`\`\``
    : "";
  return {
    ...result,
    stdout: redactSecretValues(stdout, environment),
    stderr: "",
    ...(result.errorMessage ? { errorMessage: "The local harness reported an execution failure." } : {}),
  };
}

export function buildNativeHarnessEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined
      || RUNTIME_SECRET_PATTERN.test(name)
      || RUNTIME_SECRET_NAMES.has(name)) continue;
    environment[name] = value;
  }
  const home = inherited.HOME ?? inherited.USERPROFILE ?? homedir();
  environment.HOME = home;
  if (process.platform === "win32") environment.USERPROFILE = inherited.USERPROFILE ?? home;
  return environment;
}

export interface NativeHarnessRunnerOptions {
  readonly workspacesRoot: string;
  readonly repositoryRoot: (repositoryId: string) => string | undefined | Promise<string | undefined>;
  readonly harnesses: ReadonlyMap<string, HarnessAdapter>;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly maxWorkspaceDeltaBytes?: number;
}

/**
 * Runs a locally installed harness against a disposable clone of a registered
 * repository. The harness has the operator's normal OS permissions and CLI
 * authentication; this runner does not provide a task sandbox.
 */
export class NativeHarnessRunner implements HarnessRunner {
  constructor(private readonly options: NativeHarnessRunnerOptions) {}

  async run(
    request: HarnessRunnerRequestV1,
    signal?: AbortSignal,
  ): Promise<HarnessRunnerResultV1> {
    signal?.throwIfAborted();
    const runnerRequest = parseHarnessRunnerRequest(request);
    const harness = this.options.harnesses.get(runnerRequest.harness);
    if (!harness) throw new Error(`Harness '${request.harness}' is not available on this host.`);
    const missing = runnerRequest.requiredCapabilities.filter(
      (capability) => !harness.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new Error(`Harness '${harness.name}' cannot execute task '${runnerRequest.task.id}': requires ${missing.join(", ")}.`);
    }

    const registeredPath = await this.options.repositoryRoot(runnerRequest.repositoryId);
    if (!registeredPath || !isAbsolute(registeredPath)) {
      throw new Error(`Repository '${runnerRequest.repositoryId}' is not registered with the host runner.`);
    }
    const repositoryPath = await realpath(registeredPath);
    if (!(await stat(repositoryPath)).isDirectory()) {
      throw new Error(`Registered repository '${runnerRequest.repositoryId}' is not a directory.`);
    }
    if (!isAbsolute(this.options.workspacesRoot)) {
      throw new TypeError("Host-runner workspace root must be an absolute path.");
    }
    await mkdir(this.options.workspacesRoot, { recursive: true, mode: 0o700 });
    const workspacesRoot = await realpath(this.options.workspacesRoot);
    await chmod(workspacesRoot, 0o700);
    const attemptRoot = await mkdtemp(join(workspacesRoot, "attempt-"));
    const workspacePath = join(attemptRoot, "workspace");

    try {
      const environment = buildNativeHarnessEnvironment(this.options.inheritedEnvironment);
      await cloneRepositoryAtRevision(repositoryPath, workspacePath, runnerRequest.baseRevision, {
        signal,
        env: environment,
        inheritEnvironment: false,
      });

      let cleanupUnconfirmed = false;
      const isolation: HarnessProcessIsolation = {
        environment,
        onProcessSettled: (cleanup) => {
          if (cleanup === "unconfirmed") cleanupUnconfirmed = true;
        },
      };
      const attemptRequest: TaskAttemptRequest = {
        agent: remapAgentPath(runnerRequest.agent, repositoryPath, workspacePath),
        task: runnerRequest.task,
        ...(runnerRequest.effectiveModel ? { effectiveModel: runnerRequest.effectiveModel } : {}),
        repoRoot: workspacePath,
        contextBlock: runnerRequest.contextBlock,
        requiredCapabilities: runnerRequest.requiredCapabilities,
        attempt: {
          number: runnerRequest.identity.logicalAttempt,
          maxRetries: 0,
          runId: runnerRequest.identity.runId,
        },
        budget: { timeoutMs: runnerRequest.timeoutMs },
        instructions: runnerRequest.instructions,
        ...(signal ? { signal } : {}),
        isolation,
      };
      const instructions = executionPrompt(attemptRequest, inlinePersona(attemptRequest));
      const rawResult = await harness.invoke({ ...attemptRequest, instructions });
      const result = sanitizeTaskResult(rawResult, environment);
      signal?.throwIfAborted();
      if (cleanupUnconfirmed) {
        throw new Error("Host runner could not confirm harness process-tree cleanup; rejecting the workspace result.");
      }
      const validation: HarnessRunnerValidationV1 | undefined = result.success
        && runnerRequest.task.validationCommands.length > 0
        ? await runValidationCommands({
            task: runnerRequest.task,
            workspacePath,
            timeoutMs: runnerRequest.timeoutMs,
            environment,
            signal,
            installDependencies: true,
            redact: (value) => redactSecretValues(value, environment),
          })
        : undefined;
      signal?.throwIfAborted();
      const workspaceDelta = await captureWorkspaceDelta(
        workspacePath,
        runnerRequest.baseRevision,
        {
          signal,
          env: environment,
          inheritEnvironment: false,
          maxBytes: this.options.maxWorkspaceDeltaBytes ?? DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
        },
      );
      return {
        schemaVersion: 1,
        identity: runnerRequest.identity,
        result,
        workspaceDelta,
        ...(validation ? { validation } : {}),
      };
    } finally {
      await rm(attemptRoot, { recursive: true, force: true });
    }
  }

}
