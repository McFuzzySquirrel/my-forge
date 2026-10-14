import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const directory = fileURLToPath(new URL('.', import.meta.url));
export const runtimeDirectory = join(directory, '.runtime');
export const pod = 'myforge-dapr-spike';
export const images = Object.freeze({
  daprd: 'docker.io/daprio/daprd:1.18.7',
  placement: 'docker.io/daprio/placement:1.18.7',
  scheduler: 'docker.io/daprio/scheduler:1.18.7',
  postgres: 'docker.io/library/postgres:17.6-bookworm',
  node: 'docker.io/library/node:24.11.1-bookworm-slim',
  infra: 'docker.io/library/alpine:3.21.3',
});
export const volumes = ['database', 'scheduler', 'artifacts'].map(name => `${pod}-${name}`);
export const names = ['postgres', 'placement', 'scheduler', 'daprd', 'worker'].map(name => `${pod}-${name}`);
export const localImage = 'localhost/myforge-dapr-spike:1';

export function podman(args, { allowFailure = false } = {}) {
  const result = spawnSync('podman', args,
    { encoding: 'utf8', cwd: directory, timeout: args[0] === 'exec' ? 125000 : 300000 });
  if (result.error) throw new Error(/** @type {NodeJS.ErrnoException} */ (result.error).code === 'ETIMEDOUT' ? 'Podman command exceeded its deadline' : 'Podman is required and must be on PATH');
  if (result.status !== 0 && !allowFailure) {
    // Do not copy command arguments or runtime logs containing configuration secrets.
    throw new Error(`Podman ${args[0]} failed (exit ${result.status}); inspect the spike containers locally`);
  }
  return result;
}

export function prerequisites() {
  const info = JSON.parse(podman(['info', '--format', 'json']).stdout);
  if (info.host?.security?.rootless !== true) throw new Error('Linux rootless Podman is required');
  if (process.platform !== 'linux') throw new Error('This spike only validates Linux');
  return { rootless: true, podman: info.version.Version, selinux: info.host.security.selinuxEnabled };
}

export async function setup() {
  prerequisites();
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const secretFile = join(runtimeDirectory, 'postgres.env');
  try {
    await access(secretFile);
  } catch {
    await writeFile(secretFile, `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nPOSTGRES_USER=spike\nPOSTGRES_DB=spike\n`, { mode: 0o600, flag: 'wx' });
  }
  const password = (await readFile(secretFile, 'utf8')).split('\n')[0].split('=')[1];
  await writeFile(join(runtimeDirectory, 'dapr.env'),
    `SPIKE_DATABASE_URL=host=127.0.0.1 port=5432 user=spike ${['password', password].join('=')} dbname=spike sslmode=disable\n`,
    { mode: 0o600 });
  await mkdir(join(runtimeDirectory, 'components'), { recursive: true, mode: 0o755 });
  await chmod(join(runtimeDirectory, 'components'), 0o755);
  await writeFile(join(runtimeDirectory, 'components', 'state.yaml'), `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: workflowstate
spec:
  type: state.postgresql
  version: v2
  metadata:
    - name: connectionString
      secretKeyRef:
        name: SPIKE_DATABASE_URL
        key: SPIKE_DATABASE_URL
    - name: actorStateStore
      value: "true"
auth:
  secretStore: spikeenv
`, { mode: 0o644 });
  await chmod(join(runtimeDirectory, 'components', 'state.yaml'), 0o644);
  await writeFile(join(runtimeDirectory, 'components', 'env.yaml'), `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: spikeenv
spec:
  type: secretstores.local.env
  version: v1
`, { mode: 0o644 });
  for (const volume of volumes) {
    if (podman(['volume', 'exists', volume], { allowFailure: true }).status !== 0) {
      podman(['volume', 'create', volume]);
    }
  }
  for (const image of Object.values(images)) podman(['pull', image]);
  podman(['build', '--pull=never', '--file', join(directory, 'Containerfile'), '--tag', localImage, join(directory, '../..')]);
}

export async function waitUntil(probe, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(500);
  }
  throw new Error(`Readiness timed out after ${seconds}s`);
}

function run(name, image, args = [], options = []) {
  podman(['run', '--detach', '--pull=never', '--name', `${pod}-${name}`, '--pod', pod,
    '--security-opt', 'no-new-privileges', ...options, image, ...args]);
}

export async function up() {
  prerequisites();
  await access(join(runtimeDirectory, 'postgres.env'));
  if (podman(['pod', 'exists', pod], { allowFailure: true }).status === 0) {
    const infra = podman(['pod', 'inspect', pod, '--format', '{{.InfraContainerID}}']).stdout.trim();
    for (const name of [infra, ...names.slice(0, 3)]) {
      if (podman(['inspect', name, '--format', '{{.State.Running}}']).stdout.trim() !== 'true') {
        podman(['start', name]);
      }
    }
    await waitUntil(() => podman(['exec', `${pod}-postgres`, 'pg_isready', '-U', 'spike', '-d', 'spike'], { allowFailure: true }).status === 0);
    const sidecarStopped = podman(['inspect', `${pod}-daprd`, '--format', '{{.State.Running}}']).stdout.trim() !== 'true';
    if (sidecarStopped) {
      podman(['start', `${pod}-daprd`]);
      podman(['stop', '--time', '30', `${pod}-worker`], { allowFailure: true });
    }
    if (podman(['inspect', `${pod}-worker`, '--format', '{{.State.Running}}']).stdout.trim() !== 'true') {
      podman(['start', `${pod}-worker`]);
    }
  } else {
    podman(['pod', 'create', '--name', pod, '--infra-image', images.infra,
      '--infra-command', '/bin/sleep infinity', '--network', 'none']);
    run('postgres', images.postgres, [], ['--env-file', join(runtimeDirectory, 'postgres.env'),
      '--volume', `${volumes[0]}:/var/lib/postgresql/data`]);
    await waitUntil(() => podman(['exec', `${pod}-postgres`, 'pg_isready', '-U', 'spike', '-d', 'spike'], { allowFailure: true }).status === 0);
    run('placement', images.placement, ['/placement', '--port', '50005', '--healthz-port', '8080', '--enable-metrics=false']);
    run('scheduler', images.scheduler, ['/scheduler', '--port', '50006', '--healthz-port', '8081',
      '--etcd-data-dir', '/data', '--override-broadcast-host-port', '127.0.0.1:50006',
      '--enable-metrics=false'], ['--volume', `${volumes[1]}:/data`]);
    run('daprd', images.daprd, ['/daprd', '--app-id', 'myforge-spike', '--resources-path', '/components',
      '--placement-host-address', '127.0.0.1:50005', '--scheduler-host-address', '127.0.0.1:50006',
      '--dapr-listen-addresses', '127.0.0.1', '--enable-metrics=false', '--log-level', 'warn'],
      ['--env', 'DAPR_HOST_IP=127.0.0.1', '--env-file', join(runtimeDirectory, 'dapr.env'),
        '--volume', `${join(runtimeDirectory, 'components')}:/components:ro,Z`]);
    run('worker', localImage, ['node', '--import', 'tsx', 'orchestration-worker.mjs'], ['--volume', `${volumes[2]}:/artifacts`]);
  }
  await waitUntil(async () => {
    try {
      return podman(['exec', `${pod}-worker`, 'node', '-e',
          "Promise.all([fetch('http://127.0.0.1:8083',{signal:AbortSignal.timeout(12000)}),fetch('http://127.0.0.1:3500/v1.0/healthz',{signal:AbortSignal.timeout(2000)})]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"],
        { allowFailure: true }).status === 0;
    } catch { return false; }
  });
}

export function stop() {
  prerequisites();
  podman(['stop', '--time', '30', `${pod}-worker`]);
  podman(['pod', 'stop', '--time', '30', pod]);
}

export async function restartWorker() {
  podman(['stop', '--time', '30', `${pod}-worker`]);
  const workerExitCode = Number(podman(['inspect', `${pod}-worker`, '--format', '{{.State.ExitCode}}']).stdout.trim());
  podman(['stop', '--time', '30', `${pod}-daprd`]);
  const daprdExitCode = Number(podman(['inspect', `${pod}-daprd`, '--format', '{{.State.ExitCode}}']).stdout.trim());
  if (workerExitCode !== 0 || daprdExitCode !== 0) {
    throw new Error(`Worker/sidecar shutdown failed (worker=${workerExitCode}, daprd=${daprdExitCode})`);
  }
  podman(['start', `${pod}-daprd`]);
  podman(['start', `${pod}-worker`]);
  await up();
  return { worker: workerExitCode, daprd: daprdExitCode };
}

export function clean(confirmation) {
  if (confirmation !== '--confirm-delete-volumes') throw new Error('clean requires --confirm-delete-volumes');
  prerequisites();
  podman(['pod', 'rm', '--force', pod], { allowFailure: true });
  for (const volume of volumes) podman(['volume', 'rm', volume]);
  // Retain local credentials; deleting them while a volume survives would orphan its database.
}
