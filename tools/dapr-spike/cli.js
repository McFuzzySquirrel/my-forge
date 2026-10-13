import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateInput } from './dist/workflow.js';
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

export function memoryBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i.exec(value.trim());
  if (!match) throw new Error(`Unrecognized Podman memory value: ${value}`);
  const unit = match[2].toUpperCase();
  const exponent = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, KIB: 1, MIB: 2, GIB: 3, TIB: 4 }[unit];
  const base = unit.endsWith('IB') ? 1024 : 1000;
  return Math.ceil(Number(match[1]) * base ** exponent);
}

async function measureResources(infraName) {
  const services = [infraName, ...['worker', 'daprd', 'postgres', 'placement', 'scheduler'].map(name => `${pod}-${name}`)];
  const maxMemoryBytes = 3 * 1024 ** 3;
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const result = podman(['stats', '--no-stream', '--format', 'json', ...services], { allowFailure: true });
    if (result.status !== 0 || result.stderr.includes('Failed to retrieve cgroup stats')) {
      return { measured: false, reason: `Podman stats unavailable (exit ${result.status})` };
    }
    const containers = JSON.parse(result.stdout);
    if (containers.length !== services.length) {
      throw new Error(`Expected stats for ${services.length} containers, received ${containers.length}`);
    }
    const rows = containers.map(item => ({
      service: item.name === infraName ? 'infra' : item.name.replace(`${pod}-`, ''),
      memory: item.mem_usage,
      memoryBytes: memoryBytes(item.mem_usage.split('/')[0]),
      cpu: item.cpu_percent,
    }));
    samples.push({
      measuredAt: new Date().toISOString(),
      totalMemoryBytes: rows.reduce((total, row) => total + row.memoryBytes, 0),
      containers: rows,
    });
    if (index < 4) await sleep(5_000);
  }
  const peakMemoryBytes = Math.max(...samples.map(sample => sample.totalMemoryBytes));
  return {
    measured: true,
    sampleCount: samples.length,
    maxMemoryBytes,
    peakMemoryBytes,
    peakMemoryMiB: Number((peakMemoryBytes / 1024 ** 2).toFixed(2)),
    budgetsQualified: peakMemoryBytes <= maxMemoryBytes,
    samples,
  };
}

export async function verify() {
  const started = Date.now();
  const host = prerequisites();
  if (podman(['pod', 'exists', pod], { allowFailure: true }).status === 0) stop();
  const startupStarted = Date.now();
  await up();
  const startupReadinessMs = Date.now() - startupStarted;
  assert.ok(startupReadinessMs <= 180_000, `Cached stack readiness took ${startupReadinessMs}ms (budget 180000ms)`);
  const infraId = podman(['pod', 'inspect', pod, '--format', '{{.InfraContainerID}}']).stdout.trim();
  const infraName = podman(['inspect', infraId, '--format', '{{.Name}}']).stdout.trim().replace(/^\//, '');
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
    const workerRestartExitCodes = await restartWorker();
    const workerRestartMs = Date.now() - workerStart;
    assert.ok(workerRestartMs <= 120_000, `Worker recovery took ${workerRestartMs}ms (budget 120000ms)`);
    const afterWorker = await client.getWorkflowState(runId, true);
    assert.equal(afterWorker.instanceId, runId);
    assert.equal(afterWorker.createdAt.toISOString(), timer.createdAt.toISOString());
    assert.equal(afterWorker.customStatus, 'timer', 'Restart must finish while timer is still waiting');
    phases.push({ phase: 'timer-after-worker-restart', status: afterWorker.customStatus, elapsedMs: workerRestartMs,
      stopExitCodes: workerRestartExitCodes, readiness: workerReadiness() });
    const approval = await stateAt(client, runId, 'approval');
    phases.push({ phase: 'approval-before-stack-restart', status: approval.customStatus });
    const stackStart = Date.now();
    stop();
    const stopExitCodes = Object.fromEntries(
      ['worker', 'daprd', 'postgres', 'placement', 'scheduler'].map(name => [
        name,
        Number(podman(['inspect', `${pod}-${name}`, '--format', '{{.State.ExitCode}}']).stdout.trim()),
      ]),
    );
    for (const [name, code] of Object.entries(stopExitCodes)) {
      assert.equal(code, 0, `${name} must stop gracefully while preserving the stack volumes`);
    }
    const infraExitCode = Number(podman(['inspect', infraId, '--format', '{{.State.ExitCode}}']).stdout.trim());
    await up();
    const stackRestartMs = Date.now() - stackStart;
    assert.ok(stackRestartMs <= 120_000, `Stack recovery took ${stackRestartMs}ms (budget 120000ms)`);
    const afterStack = await stateAt(client, runId, 'approval');
    assert.equal(afterStack.createdAt.toISOString(), timer.createdAt.toISOString());
    phases.push({ phase: 'approval-after-stack-restart', status: afterStack.customStatus, elapsedMs: stackRestartMs, stopExitCodes, infraExitCode,
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
    const resources = await measureResources(infraName);
    assert.equal(resources.measured, true, resources.reason ?? 'Container memory accounting is required');
    assert.equal(resources.budgetsQualified, true,
      `Peak idle memory ${resources.peakMemoryBytes} bytes exceeds ${resources.maxMemoryBytes} bytes`);
    const evidence = {
      schemaVersion: 1, measuredAt: new Date().toISOString(), result: 'passed',
      qualification: 'experimental-preparation-only',
      phaseGateAccepted: false, operatorBudgetsApproved: true,
      startupReadinessMs,
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
        shutdown: 'SIGTERM worker and service-container stack stop exit codes measured; Podman infra teardown code recorded separately'
      },
      volumesPreserved: volumes.length, elapsedMs: Date.now() - started,
      volumeAccess: 'PostgreSQL workflow state, Scheduler state, and artifact write/read verified',
      infrastructurePortsPublished: false, hostPortsPublished: 0, controlAccess: 'podman exec; SDK API on pod loopback only',
      cachedOfflineStub: true, networkMode,
      resources,
      limitations: ['Single-host clean restart, not crash/partition or cross-host recovery',
        ...(resources.budgetsQualified ? [] : ['The accepted idle-memory budget is not qualified by this run']),
        'Offline proof covers execution with cached images and dependencies, not fresh installation or online harnesses',
        'Stub activity only; no harness, Git worktree, provider, retry or cancellation qualification',
        'At-least-once activity execution; deterministic receipt prevents conflicting accepted artifact',
        'Workflow history not enumerated by the released high-level SDK; continuity checked by instance identity, creation time, phase and artifact',
        'No authenticated production control API, backup/restore or independent activity deployment',
        'Podman infrastructure container exits with code 137 during pod teardown; workload/service shutdown codes are recorded separately',
        'Host loopback port forwarding timed out in this environment; zero published ports and in-pod SDK control selected',
        'Container npm ci failed in build networking; image copies Linux host npm-installed dependencies',
        'Dapr SDK v3.18.0 exports a broad TWorkflow alias; runtime support is proven with async generators, but the registration callback is not statically constrained']
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
