/**
 * P4-06 bounds for histories, payloads, retries, and concurrency. Hard
 * ceilings reject a submission before a workflow starts; defaults apply when
 * the snapshotted settings omit a value. Values were measured against Dapr
 * 1.18.7 with SDK 3.18.0 (see plan.md "P4-06 bound evidence").
 */

/**
 * The released JS SDK worker (3.18.0) processes at most 10 work items at once
 * and queues 100 more, then drops further items with only a warning. Neither
 * value is configurable through the public API, so the engine must never let
 * long-running activities fill the slots that orchestration work items need.
 */
export const DAPR_SDK_WORKER_LIMITS = Object.freeze({
  sdkVersion: "3.18.0",
  workItemSlots: 10,
  queueCapacity: 100,
  /** Slots kept free for orchestrator replays and short status/control activities. */
  reservedOrchestrationSlots: 2,
});

/** Long-running task attempts one worker may execute at once. */
export const MAX_WORKER_TASK_ATTEMPTS =
  DAPR_SDK_WORKER_LIMITS.workItemSlots - DAPR_SDK_WORKER_LIMITS.reservedOrchestrationSlots;

export const RUN_LIMITS_V1 = Object.freeze({
  /** Selected tasks in one run snapshot. */
  maxTasksPerRun: 1_000,
  /** UTF-8 JSON bytes of the accepted submission carried as workflow input. */
  maxWorkflowInputBytes: 1024 * 1024,
  /** `configuration.settings.concurrency` ceiling: one run may use the whole worker budget. */
  maxConcurrency: MAX_WORKER_TASK_ATTEMPTS,
  /** `configuration.settings.maxRetries` ceiling. */
  maxRetries: 10,
  /** `configuration.settings.retryDelayMs` ceiling (24 hours). */
  maxRetryDelayMs: 24 * 60 * 60 * 1000,
  /** Approval waits one logical attempt may enter before it fails closed. */
  maxApprovalWaitsPerAttempt: 16,
  /** History units (child dispatches + processed controls) before the run continues as new. */
  defaultHistoryRolloverUnits: 64,
  maxHistoryRolloverUnits: 1_000,
  /** UTF-8 JSON bytes of one task outcome entering workflow history (P0 metadata cap). */
  maxTaskOutcomeBytes: 256 * 1024,
});

export { ARTIFACT_SIZE_LIMITS } from "../storage/files/artifact-checkpoint-store.ts";

export function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}
