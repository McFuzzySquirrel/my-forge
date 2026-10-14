import { DaprWorkflowClient, WorkflowRuntimeStatus } from '@dapr/dapr';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function control(method, args) {
  const client = new DaprWorkflowClient({ daprHost: '127.0.0.1', daprPort: '50001' });
  try {
    switch (method) {
      case 'start': return await client.scheduleNewWorkflow('approvalWorkflow', args[0], args[1]);
      case 'orchestration-start': {
        const [{ computeManifestDigest, validateSubmission }, { RUN_ORCHESTRATION_WORKFLOW_NAME }] = await Promise.all([
          import('./dapr-engine/contract/v1/index.ts'),
          import('./dapr-engine/orchestration/workflow.ts'),
        ]);
        const runId = args[0];
        const manifestSnapshot = {
          version: '1.0',
          phases: [{ id: 'P1', tasks: [{ id: 'T1' }] }],
        };
        const submission = {
          schemaVersion: 1,
          submissionKey: randomUUID(),
          repositoryId: 'p4-01-live-test',
          targetRef: 'refs/heads/main',
          manifestSnapshot,
          manifestDigest: computeManifestDigest(manifestSnapshot),
          selection: { mode: 'auto', requestedTaskIds: [] },
          harness: { id: 'p4-01-test-adapter', adapterVersion: '1' },
          configuration: {
            settings: { concurrency: 1, maxRetries: 1, retryDelayMs: 30_000 },
            secretRefs: {},
          },
          workflowDefinitionVersion: 'p4-01-live-test@1',
        };
        const validation = validateSubmission(submission);
        if (!validation.ok) throw new Error(`Test submission rejected: ${validation.code}`);
        submission.selection.effectiveTaskIds = validation.effectiveTaskIds;
        return await client.scheduleNewWorkflow(
          RUN_ORCHESTRATION_WORKFLOW_NAME,
          { runId, submission, controlsEnabled: false },
          runId,
        );
      }
      case 'state': {
        const state = await client.getWorkflowState(args[0], true);
        if (!state) throw new Error('Workflow instance not found');
        return {
          instanceId: state.instanceId, runtimeStatus: WorkflowRuntimeStatus[state.runtimeStatus],
          customStatus: state.customStatus, createdAt: state.createdAt.toISOString(),
          lastUpdatedAt: state.lastUpdatedAt.toISOString(), serializedOutput: state.serializedOutput,
        };
      }
      case 'approve': await client.raiseEvent(args[0], 'approval', true); return true;
      case 'task-control': {
        const { taskAttemptWorkflowId } = await import('./dapr-engine/orchestration/workflow.ts');
        await client.raiseEvent(taskAttemptWorkflowId(args[0], args[1]), 'task-control', { controlId: args[2] });
        return true;
      }
      case 'activity-log': {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(args[0])) throw new Error('Invalid run ID');
        try { return await readFile(`/artifacts/${args[0]}.jsonl`, 'utf8'); }
        catch (error) {
          if (error?.code === 'ENOENT') return '';
          throw error;
        }
      }
      case 'completed': {
        const state = await client.waitForWorkflowCompletion(args[0], true, 60);
        if (!state) throw new Error('Workflow completion unavailable');
        return { runtimeStatus: WorkflowRuntimeStatus[state.runtimeStatus], serializedOutput: state.serializedOutput };
      }
      default: throw new Error('Unsupported SDK control method');
    }
  } finally { await client.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await control(process.argv[2], JSON.parse(process.argv[3] ?? '[]')))); }
  catch { console.error('SDK control failed'); process.exitCode = 1; }
}
