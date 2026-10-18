import type { RunLifecycleEventInputV1, RunLifecycleEventV1 } from "../contract/v1/index.ts";
import type { WorkflowRuntime } from "@dapr/dapr";
import { PostgresRunStatusStore } from "../storage/postgres/run-status.ts";
import type { SqlQueryable } from "../storage/postgres/operation-receipts.ts";
import type { TransactionalSqlDatabase } from "../storage/postgres/repository-integration.ts";
import { RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME } from "./workflow.ts";

export interface RunLifecycleEventWriter {
  appendEvent(
    input: RunLifecycleEventInputV1,
  ): Promise<{ readonly event: RunLifecycleEventV1; readonly reused: boolean }>;
}

export function createRecordRunLifecycleEventActivity(writer: RunLifecycleEventWriter) {
  return async (_context: unknown, input: RunLifecycleEventInputV1): Promise<RunLifecycleEventV1> =>
    (await writer.appendEvent(input)).event;
}

export function registerRunLifecycleEventActivity(
  runtime: WorkflowRuntime,
  database: TransactionalSqlDatabase & SqlQueryable,
): WorkflowRuntime {
  return runtime.registerActivityWithName(
    RECORD_RUN_LIFECYCLE_EVENT_ACTIVITY_NAME,
    createRecordRunLifecycleEventActivity(new PostgresRunStatusStore(database)),
  );
}
