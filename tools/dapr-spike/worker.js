import { createServer } from 'node:http';
import { WorkflowRuntime, DaprWorkflowClient, WorkflowRuntimeStatus } from '@dapr/dapr';
import { randomUUID } from 'node:crypto';
import { approvalWorkflow, stubActivity } from './workflow.js';
import { waitForHttpHealth } from './readiness.js';

const runtime = new WorkflowRuntime({ daprHost: '127.0.0.1', daprPort: '50001' });
runtime.registerWorkflowWithName('approvalWorkflow', approvalWorkflow);
runtime.registerActivityWithName('stubActivity', stubActivity);
runtime.registerWorkflowWithName('readinessWorkflow', async () => true);
let ready = false;
let startupAdmissionMs;
let latestAdmissionMs;
let admission;
async function proveAdmission() {
  const started = Date.now();
  const client = new DaprWorkflowClient({ daprHost: '127.0.0.1', daprPort: '50001' });
  const instanceId = `readiness-${randomUUID()}`;
  try {
    await client.scheduleNewWorkflow('readinessWorkflow', undefined, instanceId);
    const state = await client.waitForWorkflowCompletion(instanceId, true, 10);
    if (state?.runtimeStatus !== WorkflowRuntimeStatus.COMPLETED || state.serializedOutput !== 'true') {
      throw new Error('Workflow poller did not complete the readiness probe');
    }
    await client.purgeWorkflow(instanceId);
    latestAdmissionMs = Date.now() - started;
    return true;
  } finally { await client.stop(); }
}
const server = createServer(async (_request, response) => {
  let admitted = false;
  if (ready && !stopping) {
    try {
      admission ??= proveAdmission().finally(() => { admission = undefined; });
      admitted = await admission;
    } catch { admitted = false; }
  }
  response.writeHead(admitted ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ready: admitted, startupAdmissionMs, latestAdmissionMs }));
});
server.listen(8083, '127.0.0.1');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  ready = false;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try {
    await runtime.stop();
    server.close();
    clearTimeout(deadline);
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
    server.close();
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await waitForHttpHealth('http://127.0.0.1:3500/v1.0/healthz');
  await runtime.start();
  await proveAdmission();
  startupAdmissionMs = latestAdmissionMs;
  ready = true;
} catch (error) {
  console.error('Workflow worker startup failed:', error.message);
  await stop();
  process.exitCode = 1;
}
