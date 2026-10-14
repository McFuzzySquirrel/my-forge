import {
  canonicalDigest,
  type ArtifactRefV1,
  type Sha256Digest,
} from "../contract/v1/index.ts";
import type { TaskGateResult } from "../execution/types.ts";

export interface TaskCompletionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly outputFiles: readonly string[];
  readonly handoffDigest: Sha256Digest;
  readonly artifactRefs: readonly ArtifactRefV1[];
  readonly gates: {
    readonly harness: { readonly status: "passed"; readonly evidence: readonly string[] };
    readonly outputs: { readonly status: "passed"; readonly evidence: readonly string[] };
    readonly handoff: { readonly status: "passed"; readonly evidence: readonly string[] };
    readonly requirements: { readonly status: "passed"; readonly evidence: readonly string[] };
    readonly validation: { readonly status: "passed"; readonly evidence: readonly string[] };
  };
  readonly completionDigest: Sha256Digest;
}

export interface TaskCompletionEvidenceInputV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly outputFiles: readonly string[];
  readonly handoffDigest: Sha256Digest;
  readonly artifactRefs: readonly ArtifactRefV1[];
  readonly validationCommands: readonly string[];
}

export interface TaskExecutionIdentityV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly manifestDigest: Sha256Digest;
  readonly logicalAttempt?: number;
  readonly operationId?: string;
}

export type TaskExecutionOutcomeV1 =
  | { readonly status: "complete"; readonly evidence: TaskCompletionEvidenceV1 }
  | { readonly status: "skipped" }
  | {
      readonly status: "failed";
      readonly retryable: boolean;
      readonly failureCode?: string;
      readonly reason?: string;
      readonly gates?: readonly TaskGateResult[];
    };

export function isTaskGateResults(value: unknown): value is TaskGateResult[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const gate = entry as Partial<TaskGateResult>;
    return ["harness", "outputs", "handoff", "requirements", "validation"].includes(gate.gate ?? "")
      && ["passed", "failed", "skipped"].includes(gate.status ?? "")
      && (gate.reason === undefined || typeof gate.reason === "string")
      && (gate.evidence === undefined || isStringArray(gate.evidence));
  });
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTaskCompletionEvidence(
  input: TaskCompletionEvidenceInputV1,
): TaskCompletionEvidenceV1 {
  if (!input.runId || !input.taskId || !DIGEST_PATTERN.test(input.manifestDigest)
    || !Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1
    || !UUID_PATTERN.test(input.operationId) || !DIGEST_PATTERN.test(input.handoffDigest)) {
    throw new TypeError("Task completion evidence requires valid execution identity and digests");
  }
  const validationEvidence = input.validationCommands.length > 0
    ? input.validationCommands.map((command) => `passed: ${command}`)
    : ["no validation commands declared"];
  const body = {
    schemaVersion: 1 as const,
    runId: input.runId,
    taskId: input.taskId,
    manifestDigest: input.manifestDigest,
    logicalAttempt: input.logicalAttempt,
    operationId: input.operationId,
    outputFiles: [...input.outputFiles],
    handoffDigest: input.handoffDigest,
    artifactRefs: [...input.artifactRefs],
    gates: {
      harness: { status: "passed" as const, evidence: ["harness exited successfully"] },
      outputs: {
        status: "passed" as const,
        evidence: input.outputFiles.length > 0 ? [...input.outputFiles] : ["no-op policy passed"],
      },
      handoff: { status: "passed" as const, evidence: [input.handoffDigest] },
      requirements: { status: "passed" as const, evidence: ["unresolved=[]"] },
      validation: { status: "passed" as const, evidence: validationEvidence },
    },
  };
  const evidence = { ...body, completionDigest: canonicalDigest(body) };
  if (!isTaskCompletionEvidence(evidence)) throw new TypeError("Task completion evidence is invalid");
  return evidence;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEvidenceArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((entry) => Boolean(entry.trim()));
}

function isArtifactRef(value: unknown): value is ArtifactRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<ArtifactRefV1>;
  return ref.schemaVersion === 1
    && typeof ref.artifactId === "string" && ref.artifactId.length > 0
    && typeof ref.uri === "string" && ref.uri.length > 0
    && typeof ref.mediaType === "string" && ref.mediaType.length > 0
    && Number.isSafeInteger(ref.sizeBytes) && ref.sizeBytes! >= 0
    && typeof ref.sha256 === "string" && DIGEST_PATTERN.test(ref.sha256);
}

function isPassedGate(value: unknown): value is { status: "passed"; evidence: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gate = value as { status?: unknown; evidence?: unknown };
  return gate.status === "passed" && isEvidenceArray(gate.evidence);
}

export function isTaskCompletionEvidence(
  value: unknown,
  expected?: TaskExecutionIdentityV1,
): value is TaskCompletionEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<TaskCompletionEvidenceV1>;
  if (evidence.schemaVersion !== 1
    || typeof evidence.runId !== "string" || !evidence.runId
    || typeof evidence.taskId !== "string" || !evidence.taskId
    || typeof evidence.manifestDigest !== "string" || !DIGEST_PATTERN.test(evidence.manifestDigest)
    || !Number.isSafeInteger(evidence.logicalAttempt) || evidence.logicalAttempt! < 1
    || typeof evidence.operationId !== "string" || !UUID_PATTERN.test(evidence.operationId)
    || !isStringArray(evidence.outputFiles)
    || typeof evidence.handoffDigest !== "string" || !DIGEST_PATTERN.test(evidence.handoffDigest)
    || !Array.isArray(evidence.artifactRefs) || !evidence.artifactRefs.every(isArtifactRef)
    || typeof evidence.completionDigest !== "string" || !DIGEST_PATTERN.test(evidence.completionDigest)) {
    return false;
  }
  const gates = evidence.gates;
  if (!gates || !isPassedGate(gates.harness) || !isPassedGate(gates.outputs)
    || !isPassedGate(gates.handoff) || !isPassedGate(gates.requirements)
    || !isPassedGate(gates.validation)) {
    return false;
  }
  if (expected && (evidence.runId !== expected.runId
    || evidence.taskId !== expected.taskId
    || evidence.manifestDigest !== expected.manifestDigest
    || (expected.logicalAttempt !== undefined && evidence.logicalAttempt !== expected.logicalAttempt)
    || (expected.operationId !== undefined && evidence.operationId !== expected.operationId))) {
    return false;
  }
  try {
    const { completionDigest, ...body } = evidence;
    return canonicalDigest(body) === completionDigest;
  } catch {
    return false;
  }
}
