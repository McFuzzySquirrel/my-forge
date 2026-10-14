import type { WorkflowRuntime } from "@dapr/dapr";
import {
  runOrchestrationWorkflow,
  RUN_ORCHESTRATION_WORKFLOW_NAME,
  TASK_ATTEMPT_WORKFLOW_NAME,
  taskAttemptWorkflow,
} from "./workflow.ts";

export * from "./planner.ts";
export * from "./workflow.ts";

export function registerOrchestrationWorkflows(runtime: WorkflowRuntime): WorkflowRuntime {
  return runtime
    .registerWorkflowWithName(RUN_ORCHESTRATION_WORKFLOW_NAME, runOrchestrationWorkflow)
    .registerWorkflowWithName(TASK_ATTEMPT_WORKFLOW_NAME, taskAttemptWorkflow);
}
