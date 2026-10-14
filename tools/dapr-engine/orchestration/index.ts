import type { WorkflowRuntime } from "@dapr/dapr";
import {
  createResumeTaskActivity,
  type ResumeTaskActivityDependencies,
} from "./approval-control.ts";
import {
  createApplyRunControlActivity,
  createGetRunControlActivity,
  type RunControlEffects,
} from "./run-control.ts";
import type { ApprovalControlStore } from "./approval-control.ts";
import {
  APPLY_RUN_CONTROL_ACTIVITY_NAME,
  GET_RUN_CONTROL_ACTIVITY_NAME,
  RESUME_TASK_ACTIVITY_NAME,
  runOrchestrationWorkflow,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  TASK_ATTEMPT_WORKFLOW_NAME,
  taskAttemptWorkflow,
} from "./workflow.ts";

export * from "./planner.ts";
export * from "./outcome.ts";
export * from "./activity-admission.ts";
export * from "./approval-control.ts";
export * from "./run-control.ts";
export * from "./workflow.ts";

export function registerOrchestrationWorkflows(runtime: WorkflowRuntime): WorkflowRuntime {
  return runtime
    .registerWorkflowWithName(RUN_ORCHESTRATION_WORKFLOW_NAME, runOrchestrationWorkflow)
    .registerWorkflowWithName(TASK_ATTEMPT_WORKFLOW_NAME, taskAttemptWorkflow);
}

export interface OrchestrationControlActivityDependenciesV1 {
  readonly approval: ResumeTaskActivityDependencies;
  readonly runControlStore: Pick<ApprovalControlStore, "get" | "transition">;
  readonly runControlEffects: RunControlEffects;
}

export function registerOrchestrationControlActivities(
  runtime: WorkflowRuntime,
  dependencies: OrchestrationControlActivityDependenciesV1,
): WorkflowRuntime {
  return runtime
    .registerActivityWithName(
      GET_RUN_CONTROL_ACTIVITY_NAME,
      createGetRunControlActivity(dependencies.runControlStore),
    )
    .registerActivityWithName(
      RESUME_TASK_ACTIVITY_NAME,
      createResumeTaskActivity(dependencies.approval),
    )
    .registerActivityWithName(
      APPLY_RUN_CONTROL_ACTIVITY_NAME,
      createApplyRunControlActivity(dependencies.runControlStore, dependencies.runControlEffects),
    );
}
