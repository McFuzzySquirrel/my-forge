import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateInput } from './workflow.js';
import { setup, up, stop, clean, restartWorker, prerequisites, podman, waitUntil,
  directory, pod, images, volumes } from './stack.js';

export function compactState(state) {
  if (!state) throw new Error('Workflow instance not found');
  return {
    instanceId: state.instanceId, runtimeStatus: state.runtimeStatus,
    customStatus: state.customStatus, createdAt: state.createdAt.toISOString(),
    lastUpdatedAt: state.lastUpdatedAt.toISOString(),
  };
}

async function withClient(action) {
  function invoke(method, args) {
    const result = podman(['exec', `${pod}-worker`, 'node', 'control.js', method, JSON.stringify(args)]);
    const value = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (value?.createdAt) value.createdAt = new Date(value.createdAt);
    if (value?.lastUpdatedAt) value.lastUpdatedAt = new Date(value.lastUpdatedAt);
    return value;
  }
  return action({
    scheduleNewWorkflow: async (_name, input, id) => invoke('start', [input, id]),
    getWorkflowState: async id => invoke('state', [id]),
    raiseEvent: async id => invoke('approve', [id]),
    waitForWorkflowCompletion: async id => invoke('completed', [id]),
  });
}

async function stateAt(client, runId, phase, seconds = 120) {
  let state;
  await waitUntil(async () => {
    state = await client.getWorkflowState(runId, true);
    if (state && ['FAILED', 'TERMINATED'].includes(String(state.runtimeStatus))) {
      throw new Error('Workflow failed or terminated');
    }
    if (state?.runtimeStatus === 'COMPLETED' && phase !== 'completed') {
      throw new Error('Workflow completed without reaching required wait');
    }
    return state?.customStatus === phase;
  }, seconds);
  assert.equal(state.instanceId, runId);
  return state;
}

function workerReadiness() {
  const result = podman(['exec', `${pod}-worker`, 'node', '-e',
    "fetch('http://127.0.0.1:8083',{signal:AbortSignal.timeout(12000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"]);
  const probe = JSON.parse(result.stdout.trim());
  assert.equal(probe.ready, true);
  return probe;
}

export async function verify() {
  const started = Date.now();
  const host = prerequisites();
  await up();
  const infraId = podman(['pod', 'inspect', pod, '--format', '{{.InfraContainerID}}']).stdout.trim();
  const networkMode = podman(['inspect', infraId, '--format', '{{.HostConfig.NetworkMode}}']).stdout.trim();
  assert.equal(networkMode, 'none', 'Offline stub proof requires a network-isolated pod');
  const portBindings = JSON.parse(podman(['pod', 'inspect', pod, '--format', '{{json .InfraConfig.PortBindings}}']).stdout.trim()) ?? {};
  assert.equal(Object.keys(portBindings).length, 0, 'No sidecar or infrastructure port may be published');
  const initialReadiness = workerReadiness();
  const runId = `spike-${randomUUID()}`;
  const phases = [];
  await withClient(async client => {
    const input = { runId, timerSeconds: 60 };
    assert.equal(await client.scheduleNewWorkflow('approvalWorkflow', input, runId), runId);
    const timer = await stateAt(client, runId, 'timer');
    phases.push({ phase: 'timer-before-restart', status: timer.customStatus });
    const workerStart = Date.now();
    await restartWorker();
    const afterWorker = await client.getWorkflowState(runId, true);
    assert.equal(afterWorker.instanceId, runId);
    assert.equal(afterWorker.createdAt.toISOString(), timer.createdAt.toISOString());
    assert.equal(afterWorker.customStatus, 'timer', 'Restart must finish while timer is still waiting');
    phases.push({ phase: 'timer-after-worker-restart', status: afterWorker.customStatus, elapsedMs: Date.now() - workerStart,
      readiness: workerReadiness() });
    const approval = await stateAt(client, runId, 'approval');
    phases.push({ phase: 'approval-before-stack-restart', status: approval.customStatus });
    const stackStart = Date.now();
    stop();
    const stopExitCodes = Object.fromEntries(['worker', 'daprd', 'postgres', 'placement', 'scheduler'].map(name =>
      [name, Number(podman(['inspect', `${pod}-${name}`, '--format', '{{.State.ExitCode}}']).stdout.trim())]));
    await up();
    const afterStack = await stateAt(client, runId, 'approval');
    assert.equal(afterStack.createdAt.toISOString(), timer.createdAt.toISOString());
    phases.push({ phase: 'approval-after-stack-restart', status: afterStack.customStatus, elapsedMs: Date.now() - stackStart, stopExitCodes,
      readiness: workerReadiness() });
    await client.raiseEvent(runId, 'approval', true);
    const completed = await client.waitForWorkflowCompletion(runId, true, 60);
    assert.equal(String(completed?.runtimeStatus), 'COMPLETED');
    const output = JSON.parse(completed.serializedOutput);
    assert.equal(output.approved, true);
    const artifact = podman(['exec', `${pod}-worker`, 'node', '-e',
      `process.stdout.write(require('fs').readFileSync('/artifacts/${runId}.json'))`]).stdout;
    assert.equal(createHash('sha256').update(artifact).digest('hex'), output.artifact.sha256);
    const resolvedImages = Object.fromEntries(Object.entries(images).map(([key, image]) =>
      [key, { tag: image, digest: JSON.parse(podman(['image', 'inspect', image]).stdout)[0].Digest }]));
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    const stats = podman(['stats', '--no-stream', '--format', 'json',
      ...['worker', 'daprd', 'postgres', 'placement', 'scheduler'].map(name => `${pod}-${name}`)],
    { allowFailure: true });
    const resourceAccountingUnavailable = stats.status !== 0 || stats.stderr.includes('Failed to retrieve cgroup stats');
    const evidence = {
      schemaVersion: 1, measuredAt: new Date().toISOString(), result: 'passed',
      qualification: 'experimental-preparation-only',
      phaseGateAccepted: false, operatorBudgetsApproved: false,
      versions: { hostNode: process.version, workerNode: '24.11.1', ...host,
        hostNpm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
        localTypeScript: lock.packages['node_modules/typescript'].version,
        sdk: lock.packages['node_modules/@dapr/dapr'].version,
        durabletask: lock.packages['node_modules/@dapr/durabletask-js'].version,
        stateComponent: 'state.postgresql/v2', images: resolvedImages },
      sources: [
        'https://github.com/dapr/dapr/releases/tag/v1.18.7',
        'https://github.com/dapr/js-sdk/releases/tag/v3.18.0',
        'https://github.com/dapr/js-sdk/blob/v3.18.0/test/e2e/workflow/workflow.test.ts',
        'https://github.com/dapr/components-contrib/blob/v1.18.0/state/postgresql/v2/metadata.yaml',
        'https://www.npmjs.com/package/@dapr/dapr/v/3.18.0',
        'https://docs.dapr.io/reference/components-reference/supported-state-stores/setup-postgresql-v2/'
      ],
      phases, sameInstance: true, sameCreationTime: true, artifactDigestVerified: true,
      workerReadiness: { strategy: 'A fresh SDK canary workflow must complete and be purged on each health request', initial: initialReadiness },
      outputBytes: Buffer.byteLength(completed.serializedOutput), artifactBytes: output.artifact.bytes,
      sdkCapabilities: {
        registration: 'executed', activity: 'executed', durableTimer: 'executed', externalEvent: 'executed',
        replayContinuity: 'executed through restart',
        terminateSuspendResumePurge: 'released client methods inspected, not qualified',
        retries: 'No retry-policy argument in released WorkflowContext.callActivity; not qualified',
        shutdown: 'SIGTERM worker stop and stack stop exit codes measured'
      },
      volumesPreserved: volumes.length, elapsedMs: Date.now() - started,
      infrastructurePortsPublished: false, hostPortsPublished: 0, controlAccess: 'podman exec; SDK API on pod loopback only',
      cachedOfflineStub: true, networkMode,
      resources: resourceAccountingUnavailable
        ? { measured: false, reason: 'Container cgroup accounting unavailable; budgets not qualified' }
        : { measured: true, snapshots: JSON.parse(stats.stdout).map(item => ({
          service: item.name.replace(`${pod}-`, ''), memory: item.mem_usage, cpu: item.cpu_percent
        })), budgetsQualified: false },
      limitations: ['Single-host clean restart, not crash/partition or cross-host recovery',
        'P0 formal operator budgets gate remains closed; this spike is preparation evidence, not architecture acceptance',
        'Offline proof covers execution with cached images and dependencies, not fresh installation or online harnesses',
        'Stub activity only; no harness, Git worktree, provider, retry or cancellation qualification',
        'At-least-once activity execution; deterministic receipt prevents conflicting accepted artifact',
        'Workflow history not enumerated by the released high-level SDK; continuity checked by instance identity, creation time, phase and artifact',
        'No authenticated production control API, backup/restore or independent activity deployment',
        'Podman stats returned missing-cgroup warnings and unusable measurements; resource budgets remain unqualified',
        'Host loopback port forwarding timed out in this environment; zero published ports and in-pod SDK control selected',
        'Container npm ci failed in build networking; image copies Linux host npm-installed dependencies',
        'SDK3.18.0 requires async generator workflows despite its Generator declaration; sync generators silently completed without scheduling tasks in a failed initial experiment']
    };
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  });
  return { result: 'passed', qualification: 'experimental-preparation-only', phaseGateAccepted: false, elapsedMs: Date.now() - started };
}

export async function main(args) {
  const [command, ...rest] = args;
  switch (command) {
    case 'setup': await setup(); return { result: 'setup' };
    case 'up': await up(); return { result: 'ready' };
    case 'stop': stop(); return { result: 'stopped', volumesPreserved: true };
    case 'clean': clean(rest[0]); return { result: 'volumes-deleted' };
    case 'restart-worker': await restartWorker(); return { result: 'ready' };
    case 'verify': return verify();
    case 'start': {
      const runId = rest[0] ?? `spike-${randomUUID()}`;
      const input = validateInput({ runId, timerSeconds: Number(rest[1] ?? 30) });
      return withClient(async client => ({ instanceId: await client.scheduleNewWorkflow('approvalWorkflow', input, runId) }));
    }
    case 'status':
      if (!rest[0]) throw new Error('status requires runId');
      return withClient(async client => compactState(await client.getWorkflowState(rest[0], true)));
    case 'approve':
      if (!rest[0]) throw new Error('approve requires runId');
      return withClient(async client => { await client.raiseEvent(rest[0], 'approval', true); return { instanceId: rest[0], eventSubmitted: true }; });
    default: throw new Error('Use setup | up | start [runId] [timerSeconds] | status runId | approve runId | restart-worker | stop | verify | clean --confirm-delete-volumes');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
