import type { Sha256Digest } from "./types.ts";

export type AttemptStatusV1 = "running" | "waiting-for-approval" | "complete" | "failed" | "skipped" | "cancelled";

export type RunLifecycleEventTypeV1 =
  | "run.created"
  | "run.started"
  | "run.pausing"
  | "run.paused"
  | "run.stopping"
  | "run.stopped"
  | "run.cancelling"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "run.reopened"
  | "run.resumed"
  | "attempt.started"
  | "attempt.waiting-for-approval"
  | "attempt.resumed"
  | "attempt.failed"
  | "task.completed"
  | "task.failed"
  | "task.skipped"
  | "task.cancelled"
  | "task.replayed";

export interface RunStatusCreateV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly manifestDigest: Sha256Digest;
  readonly taskIds: readonly string[];
}

export interface RunLifecycleEventInputV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  /** Stable across activity redelivery; unique within a run. */
  readonly eventKey: string;
  readonly eventType: RunLifecycleEventTypeV1;
  readonly taskId?: string;
  readonly logicalAttempt?: number;
  readonly runStatus?: import("./types.ts").RunStatusV1;
  readonly taskStatus?: import("./types.ts").TaskStatusV1;
  readonly attemptStatus?: AttemptStatusV1;
  readonly detail?: Readonly<Record<string, import("./types.ts").JsonValue>>;
}

export interface RunLifecycleEventV1 extends RunLifecycleEventInputV1 {
  readonly sequence: number;
  readonly createdAt: string;
}

export interface TaskAttemptStatusV1 {
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly status: AttemptStatusV1;
  readonly updatedAt: string;
  readonly observedAt: string;
}

export interface TaskStatusSnapshotV1 {
  readonly taskId: string;
  readonly status: import("./types.ts").TaskStatusV1;
  readonly logicalAttempt?: number;
  readonly attempts: readonly TaskAttemptStatusV1[];
  readonly updatedAt: string;
  readonly observedAt: string;
}

export interface RunStatusIdentityV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly manifestDigest: Sha256Digest;
  readonly status: import("./types.ts").RunStatusV1;
  /** Last committed audit sequence for this run. */
  readonly revision: number;
  readonly observedAt: string;
}

export interface RunStatusSnapshotV1 extends RunStatusIdentityV1 {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tasks: readonly TaskStatusSnapshotV1[];
}

export interface TaskStatusResponseV1 {
  readonly run: RunStatusIdentityV1;
  readonly task: TaskStatusSnapshotV1;
}

export interface TaskAttemptStatusResponseV1 {
  readonly run: RunStatusIdentityV1;
  readonly attempt: TaskAttemptStatusV1;
}

export interface RunLifecycleEventPageV1 {
  readonly events: readonly RunLifecycleEventV1[];
  readonly cursor: number;
  readonly hasMore: boolean;
}
