// Dapr execution contract v1 record shapes (docs/contracts/dapr-execution-v1.md).
// These types are Dapr-independent application records; they never describe
// Dapr workflow history.

export const SCHEMA_VERSION = 1 as const;

export type Sha256Digest = `sha256:${string}`;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The task graph subset of an execution manifest that the contract interprets. */
export interface ManifestGraphTaskV1 {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly ownerAgent?: string;
}

export interface ManifestGraphPhaseV1 {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly tasks: readonly ManifestGraphTaskV1[];
}

/** Immutable resolved manifest and requirement/task contract snapshot. */
export interface ManifestSnapshotV1 {
  readonly phases: readonly ManifestGraphPhaseV1[];
  readonly [key: string]: unknown;
}

export type SelectionMode = "auto" | "manual";

export interface SelectionV1 {
  readonly mode: SelectionMode;
  readonly requestedTaskIds: readonly string[];
  /** Frozen by the service; a caller-supplied value is ignored. */
  readonly effectiveTaskIds?: readonly string[];
}

export interface HarnessSelectionV1 {
  readonly id: string;
  readonly adapterVersion: string;
}

export interface SecretReferenceV1 {
  readonly ref: string;
  readonly version?: string;
}

export interface RunConfigurationV1 {
  /** Non-secret resolved settings. */
  readonly settings: Readonly<Record<string, JsonValue>>;
  /** External secret identifiers; never secret values. */
  readonly secretRefs: Readonly<Record<string, SecretReferenceV1>>;
}

export interface RunSubmissionV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly submissionKey: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly manifestSnapshot: ManifestSnapshotV1;
  readonly manifestDigest: Sha256Digest;
  readonly selection: SelectionV1;
  readonly harness: HarnessSelectionV1;
  readonly configuration: RunConfigurationV1;
  readonly workflowDefinitionVersion: string;
}

export type SubmissionRejectionCode =
  | "unsupported-schema-version"
  | "invalid-submission"
  | "manifest-digest-mismatch"
  | "secret-value-in-snapshot"
  | "unknown-selected-task"
  | "unresolved-dependency"
  | "submission-conflict";

export type RunStatusV1 =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "cancelling"
  | "complete"
  | "failed"
  | "cancelled";

export type TaskStatusV1 =
  | "pending"
  | "ready"
  | "running"
  | "waiting-for-approval"
  | "complete"
  | "failed"
  | "skipped"
  | "cancelled";

export type ControlAction =
  | "select-tasks"
  | "pause"
  | "resume"
  | "stop"
  | "cancel"
  | "replay-task"
  | "approve-task";

export interface ControlRequestV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly controlId: string;
  readonly runId: string;
  readonly action: ControlAction;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export type ControlState = "requested" | "accepted" | "applied" | "rejected";

export type ControlRejectionCode =
  | "unsupported-schema-version"
  | "unknown-run"
  | "control-conflict"
  | "invalid-run-state"
  | "invalid-task-state"
  | "unknown-task"
  | "selection-immutable"
  | "operator-identity-required"
  | "stale-evidence";

export interface ControlRecordV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly controlId: string;
  readonly runId: string;
  readonly action: ControlAction;
  readonly requestDigest: Sha256Digest;
  readonly state: ControlState;
  readonly history: readonly ControlState[];
  readonly reasonCode?: ControlRejectionCode;
}

export type ReceiptState = "claimed" | "executing" | "effect-published" | "accepted" | "failed" | "ambiguous";

export interface OperationKeyV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
}

export interface OperationReceiptV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly key: OperationKeyV1;
  readonly state: ReceiptState;
  readonly recordVersion: number;
  readonly effectDigest?: Sha256Digest;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly diagnosticRefs: readonly string[];
}

export type RetentionClass = "terminal-diagnostic" | "checkpoint-evidence";

export interface ArtifactRefV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly artifactId: string;
  readonly uri: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: Sha256Digest;
  readonly sensitivity?: "normal" | "sensitive";
  readonly retentionClass?: RetentionClass;
}

export interface CheckpointV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly parentCheckpointDigest?: Sha256Digest;
  readonly artifacts: readonly ArtifactRefV1[];
  readonly gitTreeId: string;
}

export interface CheckpointChangeV1 {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted";
  readonly binary: boolean;
  readonly baseBlobOid?: string;
  readonly resultBlobOid?: string;
  readonly baseMode?: string;
  readonly resultMode?: string;
}

export interface ToolchainEntryV1 {
  readonly name: string;
  readonly version: string;
}

export interface DependencyLockfileV1 {
  readonly path: string;
  readonly artifact: ArtifactRefV1;
}

export interface TaskCheckpointV1 extends CheckpointV1 {
  readonly baseRevision: string;
  readonly changes: readonly CheckpointChangeV1[];
  readonly gitObjectIds: readonly string[];
  readonly gitObjectBundle: ArtifactRefV1;
  readonly validationEvidence: readonly ArtifactRefV1[];
  readonly toolchain: readonly ToolchainEntryV1[];
  readonly dependencyLockfiles: readonly DependencyLockfileV1[];
}

export interface FencingLeaseV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly fencingToken: number;
  readonly ownerRunId: string;
  readonly expiresAt: string;
  readonly revision: number;
}
