import {
  validateSubmission,
  type RunSubmissionV1,
  type TaskStatusV1,
} from "../contract/v1/index.ts";
import { RUN_LIMITS_V1, utf8JsonBytes } from "./limits.ts";

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 5_000;
export const DEFAULT_CONCURRENCY = 1;

export interface AcceptedRunSubmissionV1 extends RunSubmissionV1 {
  readonly selection: RunSubmissionV1["selection"] & {
    readonly effectiveTaskIds: readonly string[];
  };
}

export interface PlannedTaskV1 {
  readonly taskId: string;
  readonly ownerAgent?: string;
  readonly prerequisites: readonly string[];
}

export interface OrchestrationPlanV1 {
  readonly tasks: readonly PlannedTaskV1[];
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly allowNoop: boolean;
  /** History units (dispatches + processed controls) before the run workflow continues as new. */
  readonly historyRolloverUnits: number;
}

function setting(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`configuration.settings.${key} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanSetting(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`configuration.settings.${key} must be a boolean`);
  return value;
}

function validateAcyclic(tasks: readonly PlannedTaskV1[]): void {
  const prerequisites = new Map(tasks.map((task) => [task.taskId, task.prerequisites]));
  const visited = new Set<string>();
  const active: string[] = [];

  const visit = (taskId: string): void => {
    const cycleStart = active.indexOf(taskId);
    if (cycleStart >= 0) {
      throw new Error(`Task dependency cycle: ${[...active.slice(cycleStart), taskId].join(" -> ")}`);
    }
    if (visited.has(taskId)) return;
    active.push(taskId);
    for (const dependency of prerequisites.get(taskId) ?? []) visit(dependency);
    active.pop();
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.taskId);
}

/** Builds the immutable, manifest-ordered task graph used by the workflow. */
export function buildOrchestrationPlan(
  submission: AcceptedRunSubmissionV1,
): OrchestrationPlanV1 {
  const validation = validateSubmission(submission);
  if (!validation.ok) {
    throw new Error(`Invalid run submission (${validation.code}): ${validation.detail}`);
  }
  const inputBytes = utf8JsonBytes(submission);
  if (inputBytes > RUN_LIMITS_V1.maxWorkflowInputBytes) {
    throw new Error(
      `Run submission is ${inputBytes} bytes; the workflow input limit is ${RUN_LIMITS_V1.maxWorkflowInputBytes} bytes`,
    );
  }
  const frozenSelection = submission.selection.effectiveTaskIds;
  if (!Array.isArray(frozenSelection)
    || frozenSelection.length !== validation.effectiveTaskIds.length
    || frozenSelection.some((taskId, index) => taskId !== validation.effectiveTaskIds[index])) {
    throw new Error("Frozen effective task selection does not match the immutable submission");
  }
  if (frozenSelection.length > RUN_LIMITS_V1.maxTasksPerRun) {
    throw new Error(
      `Run selects ${frozenSelection.length} tasks; at most ${RUN_LIMITS_V1.maxTasksPerRun} tasks are allowed per run`,
    );
  }

  const selected = new Set(frozenSelection);
  const phaseTasks = new Map(submission.manifestSnapshot.phases.map((phase) => [
    phase.id,
    phase.tasks.map((task) => task.id),
  ]));
  for (const phase of submission.manifestSnapshot.phases) {
    for (const task of phase.tasks) {
      if (task.ownerAgent !== undefined && typeof task.ownerAgent !== "string") {
        throw new Error(`Task '${task.id}' has a non-string ownerAgent`);
      }
    }
  }

  const tasks: PlannedTaskV1[] = [];
  for (const phase of submission.manifestSnapshot.phases) {
    const phasePrerequisites = (phase.dependencies ?? []).flatMap((phaseId) => {
      const dependencyTasks = phaseTasks.get(phaseId);
      if (!dependencyTasks) throw new Error(`Phase '${phase.id}' depends on unknown phase '${phaseId}'`);
      return dependencyTasks;
    });
    for (const task of phase.tasks) {
      if (!selected.has(task.id)) continue;
      const dependencies = [...new Set([...(task.dependencies ?? []), ...phasePrerequisites])];
      for (const dependency of dependencies) {
        if (!selected.has(dependency)) {
          throw new Error(`Selected task '${task.id}' is missing prerequisite '${dependency}'`);
        }
      }
      tasks.push({
        taskId: task.id,
        ...(task.ownerAgent !== undefined ? { ownerAgent: task.ownerAgent } : {}),
        prerequisites: dependencies,
      });
    }
  }
  validateAcyclic(tasks);

  const settings = submission.configuration.settings as Readonly<Record<string, unknown>>;
  const maxRetries = setting(settings, "maxRetries", DEFAULT_MAX_RETRIES, 0, RUN_LIMITS_V1.maxRetries);
  const retryDelayMs = setting(settings, "retryDelayMs", DEFAULT_RETRY_DELAY_MS, 0, RUN_LIMITS_V1.maxRetryDelayMs);
  const maxConcurrency = setting(settings, "concurrency", DEFAULT_CONCURRENCY, 1, RUN_LIMITS_V1.maxConcurrency);
  const historyRolloverUnits = setting(
    settings,
    "historyRolloverUnits",
    RUN_LIMITS_V1.defaultHistoryRolloverUnits,
    1,
    RUN_LIMITS_V1.maxHistoryRolloverUnits,
  );
  const allowNoop = booleanSetting(settings, "allowNoop", false);

  return {
    tasks,
    maxConcurrency: Math.min(maxConcurrency, tasks.length || 1),
    maxRetries,
    retryDelayMs,
    allowNoop,
    historyRolloverUnits,
  };
}

/** Selects one manifest-ordered dispatch wave under dependency/owner limits. */
export function nextDispatchWave(
  tasks: readonly PlannedTaskV1[],
  statuses: Readonly<Record<string, TaskStatusV1>>,
  maxConcurrency: number,
): PlannedTaskV1[] {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive safe integer");
  }

  const owners = new Set<string>();
  const wave: PlannedTaskV1[] = [];
  for (const task of tasks) {
    if (statuses[task.taskId] !== "pending") continue;
    if (!task.prerequisites.every((id) => statuses[id] === "complete" || statuses[id] === "skipped")) continue;
    const owner = task.ownerAgent ?? "__unassigned__";
    if (owners.has(owner)) continue;
    owners.add(owner);
    wave.push(task);
    if (wave.length >= maxConcurrency) break;
  }
  return wave;
}
