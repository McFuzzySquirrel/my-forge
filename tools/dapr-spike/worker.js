import { createServer } from 'node:http';
import { WorkflowRuntime } from '@dapr/dapr';
import { setTimeout as sleep } from 'node:timers/promises';
import { approvalWorkflow, stubActivity } from './workflow.js';

const runtime = new WorkflowRuntime({ daprHost: '127.0.0.1', daprPort: '50001' });
runtime.registerWorkflowWithName('approvalWorkflow', approvalWorkflow);
runtime.registerActivityWithName('stubActivity', stubActivity);
let ready = false;
const server = createServer((_request, response) => {
  response.writeHead(ready ? 200 : 503);
  response.end(ready ? 'ready' : 'starting');
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
  const deadline = Date.now() + 90000;
  let sidecarReady = false;
  while (!sidecarReady && Date.now() < deadline && !stopping) {
    try {
      sidecarReady = (await fetch('http://127.0.0.1:3500/v1.0/healthz', { signal: AbortSignal.timeout(2000) })).ok;
    } catch { /* The sidecar is still starting. */ }
    if (!sidecarReady) await sleep(500);
  }
  if (!sidecarReady) throw new Error('Sidecar readiness deadline exceeded');
  await runtime.start();
  ready = true;
} catch (error) {
  console.error('Workflow worker startup failed:', error.message);
  await stop();
  process.exitCode = 1;
}
