import type {
  AgentDescriptor,
  ManifestTask,
  TaskCapability,
} from "../../../templates/skills/forge-execution-adapter/scripts/types.ts";

export type { AgentDescriptor, ManifestTask, TaskCapability };

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface TaskAttemptSummary {
  attempt: number;
  outcome: "passed" | "failed" | "cancelled";
  resultPath: string;
  reason?: string;
}

export interface TaskGateResult {
  gate: "harness" | "outputs" | "handoff" | "requirements" | "validation";
  status: "passed" | "failed" | "skipped";
  reason?: string;
  evidence?: string[];
}

export interface TaskResult {
  success: boolean;
  outputFiles: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
  errorMessage?: string;
  failureKind?: TaskFailureKind;
}

export type TaskFailureKind = "retryable" | "configuration" | "exception" | "timeout" | "cancelled";
export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

export interface TaskAttemptRequest {
  readonly agent: DeepReadonly<AgentDescriptor>;
  readonly task: DeepReadonly<ManifestTask>;
  readonly effectiveModel?: string;
  readonly repoRoot: string;
  readonly contextBlock: string;
  readonly requiredCapabilities: readonly TaskCapability[];
  readonly attempt: Readonly<{ number: number; maxRetries: number; runId: string }>;
  readonly budget: Readonly<{ timeoutMs: number }>;
  readonly instructions: string;
  readonly signal?: AbortSignal;
  readonly logHarnessActivity?: boolean;
  /** Optional per-attempt activity sink; defaults to stdout. */
  readonly log?: (line: string) => void;
  /** Present for supervised service executions; absent for legacy runs. */
  readonly isolation?: HarnessProcessIsolation;
}

/** See `buildHarnessEnvironment` in `isolation.ts`. */
export interface HarnessProcessIsolation {
  /** Complete child environment; the worker's own environment is not inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** Per-attempt POSIX identity, used by the service worker to isolate tasks. */
  readonly processIdentity?: ProcessIdentityV1;
  /** Called once per harness process with whether its process-tree termination was observed. */
  readonly onProcessSettled?: (cleanup: "observed" | "unconfirmed") => void;
}

export interface ProcessIdentityV1 {
  readonly uid: number;
  readonly gid: number;
}

export interface HarnessRunContext {
  readonly repoRoot: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly supportsConcurrency: boolean;
  readonly capabilities: readonly TaskCapability[];
  readonly defaultModel?: string;
  prepare?(context: HarnessRunContext): Promise<void>;
  cleanup?(): Promise<void>;
  invoke(request: TaskAttemptRequest): Promise<TaskResult>;
}

export interface Artifact {
  artifactId: string;
  type: string;
  category: "decision" | "work" | "evidence";
  taskId: string;
  producedBy: string;
  createdAt: string;
  status: "complete" | "failed";
  summary: string;
  confidence?: number;
  inputs: string[];
  filesChanged: string[];
  payload: Record<string, unknown>;
  nextActions: string[];
}

export interface ArtifactProjection {
  taskId: string;
  projectedAt: string;
  artifacts: Array<{
    artifactId: string;
    type: string;
    summary: string;
    confidence?: number;
    selectedFields: Record<string, unknown>;
  }>;
  sourceTokenEstimate: number;
  projectedTokenEstimate: number;
}
