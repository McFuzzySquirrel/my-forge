import { DaprWorkflowClient, WorkflowRuntimeStatus } from '@dapr/dapr';
import { pathToFileURL } from 'node:url';

export async function control(method, args) {
  const client = new DaprWorkflowClient({ daprHost: '127.0.0.1', daprPort: '50001' });
  try {
    switch (method) {
      case 'start': return await client.scheduleNewWorkflow('approvalWorkflow', args[0], args[1]);
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
