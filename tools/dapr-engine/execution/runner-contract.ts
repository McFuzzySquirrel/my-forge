import { sha256Digest, type Sha256Digest } from "../contract/v1/index.ts";
import type {
  AgentDescriptor,
  DeepReadonly,
  ManifestTask,
  TaskCapability,
  TaskResult,
} from "./types.ts";

export interface HarnessRunnerIdentityV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
}

export interface HarnessRunnerRequestV1 {
  readonly schemaVersion: 1;
  readonly identity: HarnessRunnerIdentityV1;
  readonly repositoryId: string;
  readonly baseRevision: string;
  readonly harness: string;
  readonly agent: DeepReadonly<AgentDescriptor>;
  readonly task: DeepReadonly<ManifestTask>;
  readonly effectiveModel?: string;
  readonly contextBlock: string;
  readonly requiredCapabilities: readonly TaskCapability[];
  readonly timeoutMs: number;
  readonly instructions: string;
}

export interface HarnessRunnerWorkspaceDeltaV1 {
  readonly format: "git-binary-diff-v1";
  readonly baseRevision: string;
  readonly digest: Sha256Digest;
  readonly contentBase64: string;
}

export interface HarnessRunnerResultV1 {
  readonly schemaVersion: 1;
  readonly identity: HarnessRunnerIdentityV1;
  readonly result: TaskResult;
  readonly workspaceDelta: HarnessRunnerWorkspaceDeltaV1;
}

export interface HarnessRunner {
  run(
    request: HarnessRunnerRequestV1,
    signal?: AbortSignal,
  ): Promise<HarnessRunnerResultV1>;
}

const FAILURE_KINDS = new Set(["retryable", "configuration", "exception", "timeout", "cancelled"]);
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates data crossing the Dapr-service/host-runner transport boundary. */
export function parseHarnessRunnerRequest(value: unknown): HarnessRunnerRequestV1 {
  if (!record(value)
    || value.schemaVersion !== 1
    || !record(value.identity)
    || !record(value.agent)
    || !record(value.task)
    || typeof value.repositoryId !== "string"
    || !REPOSITORY_ID_PATTERN.test(value.repositoryId)
    || typeof value.baseRevision !== "string" || !GIT_REVISION_PATTERN.test(value.baseRevision)
    || typeof value.harness !== "string" || value.harness.length === 0 || value.harness.length > 128
    || (value.effectiveModel !== undefined && typeof value.effectiveModel !== "string")
    || typeof value.contextBlock !== "string"
    || !stringArray(value.requiredCapabilities)
    || value.requiredCapabilities.some((capability) => capability !== "text" && capability !== "repository-tools")
    || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) <= 0
    || typeof value.instructions !== "string") {
    throw new TypeError("Host-runner request has an invalid schema.");
  }
  const identity = parseIdentity(value.identity);
  if (identity.taskId !== value.task.id
    || !REPOSITORY_ID_PATTERN.test(value.repositoryId)
    || !OPERATION_ID_PATTERN.test(identity.operationId)
    || !/^run_[0-9a-f]{32}$/.test(identity.runId)
    || typeof value.task.id !== "string"
    || typeof value.agent.name !== "string"
    || typeof value.agent.description !== "string"
    || typeof value.agent.path !== "string"
    || !stringArray(value.agent.expertise)
    || !stringArray(value.agent.collaboration)
    || !stringArray(value.agent.constraints)
    || typeof value.agent.rawBody !== "string"
    || typeof value.task.title !== "string"
    || typeof value.task.description !== "string"
    || !stringArray(value.task.dependencies)
    || !stringArray(value.task.expectedOutputs)
    || !stringArray(value.task.validationCommands)
    || !stringArray(value.task.sourceLines)
    || typeof value.task.approvalRequired !== "boolean") {
    throw new TypeError("Host-runner request has invalid task or agent data.");
  }
  const contextBlock = value.contextBlock;
  const instructions = value.instructions;
  if (Buffer.byteLength(contextBlock, "utf8") > 2 * 1024 * 1024
    || Buffer.byteLength(instructions, "utf8") > 2 * 1024 * 1024) {
    throw new RangeError("Host-runner request context exceeds the configured size limit.");
  }
  const agent: DeepReadonly<AgentDescriptor> = {
    name: value.agent.name,
    description: value.agent.description,
    path: value.agent.path,
    ...(typeof value.agent.model === "string" ? { model: value.agent.model } : {}),
    ...(typeof value.agent.modelFallback === "string" ? { modelFallback: value.agent.modelFallback } : {}),
    expertise: [...value.agent.expertise],
    collaboration: [...value.agent.collaboration],
    constraints: [...value.agent.constraints],
    rawBody: value.agent.rawBody,
  };
  const task = structuredClone(value.task) as DeepReadonly<ManifestTask>;
  const requiredCapabilities: TaskCapability[] = value.requiredCapabilities.map(
    (capability) => capability as TaskCapability,
  );
  return {
    schemaVersion: 1,
    identity,
    repositoryId: value.repositoryId,
    baseRevision: value.baseRevision,
    harness: value.harness,
    agent,
    task,
    ...(typeof value.effectiveModel === "string" ? { effectiveModel: value.effectiveModel } : {}),
    contextBlock,
    requiredCapabilities,
    timeoutMs: Number(value.timeoutMs),
    instructions,
  };
}

function parseIdentity(value: unknown): HarnessRunnerIdentityV1 {
  if (!record(value)
    || typeof value.runId !== "string" || value.runId.length === 0
    || typeof value.taskId !== "string" || value.taskId.length === 0
    || typeof value.manifestDigest !== "string" || !SHA256_DIGEST_PATTERN.test(value.manifestDigest)
    || !Number.isSafeInteger(value.logicalAttempt) || Number(value.logicalAttempt) < 1
    || typeof value.operationId !== "string" || value.operationId.length === 0) {
    throw new TypeError("Host-runner response has an invalid execution identity.");
  }
  return {
    runId: value.runId,
    taskId: value.taskId,
    manifestDigest: value.manifestDigest as Sha256Digest,
    logicalAttempt: Number(value.logicalAttempt),
    operationId: value.operationId,
  };
}

function assertIdentityMatches(
  actual: HarnessRunnerIdentityV1,
  expected: HarnessRunnerIdentityV1,
): void {
  if (actual.runId !== expected.runId
    || actual.taskId !== expected.taskId
    || actual.manifestDigest !== expected.manifestDigest
    || actual.logicalAttempt !== expected.logicalAttempt
    || actual.operationId !== expected.operationId) {
    throw new Error("Host-runner response does not match the requested attempt.");
  }
}

function parseTaskResult(value: unknown): TaskResult {
  if (!record(value)
    || typeof value.success !== "boolean"
    || !stringArray(value.outputFiles)
    || typeof value.stdout !== "string"
    || typeof value.stderr !== "string"
    || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || (value.errorMessage !== undefined && typeof value.errorMessage !== "string")
    || (value.failureKind !== undefined
      && (typeof value.failureKind !== "string" || !FAILURE_KINDS.has(value.failureKind)))) {
    throw new TypeError("Host-runner response has an invalid task result.");
  }
  return {
    success: value.success,
    outputFiles: value.outputFiles,
    stdout: value.stdout,
    stderr: value.stderr,
    durationMs: value.durationMs,
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    ...(typeof value.failureKind === "string"
      ? { failureKind: value.failureKind as TaskResult["failureKind"] }
      : {}),
  };
}

/** Validates attempt fencing and the integrity/size of a transferred workspace diff. */
export function parseHarnessRunnerResult(
  request: HarnessRunnerRequestV1,
  value: unknown,
  maxWorkspaceDeltaBytes: number,
): HarnessRunnerResultV1 {
  if (!Number.isSafeInteger(maxWorkspaceDeltaBytes) || maxWorkspaceDeltaBytes < 0) {
    throw new RangeError("Maximum workspace delta size must be a non-negative safe integer.");
  }
  if (!record(value) || value.schemaVersion !== 1 || !record(value.workspaceDelta)) {
    throw new TypeError("Host-runner response has an unsupported or invalid schema.");
  }
  const identity = parseIdentity(value.identity);
  assertIdentityMatches(identity, request.identity);
  const delta = value.workspaceDelta;
  if (delta.format !== "git-binary-diff-v1"
    || delta.baseRevision !== request.baseRevision
    || typeof delta.baseRevision !== "string"
    || typeof delta.digest !== "string" || !SHA256_DIGEST_PATTERN.test(delta.digest)
    || typeof delta.contentBase64 !== "string"
    || !GIT_REVISION_PATTERN.test(delta.baseRevision)) {
    throw new TypeError("Host-runner response has an invalid workspace delta.");
  }
  if (delta.contentBase64.length > Math.ceil(maxWorkspaceDeltaBytes / 3) * 4) {
    throw new RangeError(`Host-runner workspace delta exceeds ${maxWorkspaceDeltaBytes} bytes.`);
  }
  const bytes = Buffer.from(delta.contentBase64, "base64");
  if (bytes.toString("base64") !== delta.contentBase64) {
    throw new TypeError("Host-runner workspace delta is not canonical base64.");
  }
  if (bytes.byteLength > maxWorkspaceDeltaBytes) {
    throw new RangeError(`Host-runner workspace delta exceeds ${maxWorkspaceDeltaBytes} bytes.`);
  }
  if (sha256Digest(bytes) !== delta.digest) {
    throw new Error("Host-runner workspace delta digest does not match its content.");
  }
  return {
    schemaVersion: 1,
    identity,
    result: parseTaskResult(value.result),
    workspaceDelta: {
      format: "git-binary-diff-v1",
      baseRevision: delta.baseRevision,
      digest: delta.digest as Sha256Digest,
      contentBase64: delta.contentBase64,
    },
  };
}
