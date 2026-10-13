import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { waitForHttpHealth } from './readiness.js';
import { approvalWorkflow, persistArtifact, validateInput } from './workflow.js';
import { compactState, main } from './cli.js';
import { clean, images, directory, waitUntil } from './stack.js';

test('validates input and rejects traversal or unbounded timers', () => {
  assert.equal(validateInput({ runId: 'ok-1', timerSeconds: 1 }).runId, 'ok-1');
  for (const timerSeconds of [0, 601, NaN, 1.5]) {
    assert.throws(() => validateInput({ runId: 'ok', timerSeconds }));
  }
  assert.throws(() => validateInput({ runId: '../escape', timerSeconds: 1 }));
});

test('workflow deterministically schedules activity, timer, then approval', async () => {
  const calls = [];
  const context = /** @type {any} */ ({
    callActivity: (name, input) => ({ name, input }),
    setCustomStatus: status => calls.push(status),
    createTimer: seconds => ({ timer: seconds }),
    waitForExternalEvent: name => ({ event: name }),
  });
  const workflow = approvalWorkflow(context, { runId: 'unit', timerSeconds: 3 });
  assert.deepEqual((await workflow.next()).value, { name: 'stubActivity', input: { runId: 'unit' } });
  assert.deepEqual((await workflow.next({ key: 'artifact' })).value, { timer: 3 });
  assert.deepEqual((await workflow.next()).value, { event: 'approval' });
  const completed = await workflow.next(true);
  assert.equal(completed.done, true);
  assert.equal(/** @type {any} */ (completed.value).approved, true);
  assert.deepEqual(calls, ['timer', 'approval', 'completed']);
});

test('artifact receipt is stable and conflicting receipts fail', async () => {
  const scratch = join(directory, '.runtime', `test-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    const first = await persistArtifact(scratch, 'unit');
    assert.deepEqual(await persistArtifact(scratch, 'unit'), first);
    assert.equal(Buffer.byteLength(await readFile(join(scratch, first.key), 'utf8')), first.bytes);
    await writeFile(join(scratch, first.key), 'conflict');
    await assert.rejects(persistArtifact(scratch, 'unit'), /conflict/);
  } finally { await rm(scratch, { recursive: true }); }
});

test('missing workflow and unsupported commands fail', async () => {
  assert.throws(() => compactState(undefined), /not found/);
  await assert.rejects(main(['unknown']), /Use setup/);
  await assert.rejects(main(['status']), /requires runId/);
});

test('destructive cleanup requires explicit confirmation before touching Podman', () => {
  assert.throws(() => clean(undefined), /confirm-delete-volumes/);
  assert.throws(() => clean('yes'), /confirm-delete-volumes/);
  for (const image of Object.values(images)) assert.match(image, /:\d+\.\d+/);
});

test('missing Podman prerequisite exits nonzero', () => {
  const result = spawnSync(process.execPath, ['cli.js', 'up'], {
    cwd: directory, env: { ...process.env, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Podman is required/);
});

test('workflow rejects non-approval event payload', async () => {
  const context = /** @type {any} */ ({
    callActivity: () => ({}), setCustomStatus: () => {},
    createTimer: () => ({}), waitForExternalEvent: () => ({}),
  });
  const workflow = approvalWorkflow(context, { runId: 'unit', timerSeconds: 1 });
  await workflow.next();
  await workflow.next({});
  await workflow.next();
  await assert.rejects(workflow.next(false), /Approval must be true/);
});

test('readiness deadline fails on a real HTTP server that never responds', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    await assert.rejects(waitForHttpHealth(`http://127.0.0.1:${address.port}`, 80, 20), /deadline exceeded/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('bounded readiness polling propagates deadline and probe failure', async () => {
  await assert.rejects(waitUntil(async () => false, 0.01), /Readiness timed out/);
  await assert.rejects(waitUntil(async () => { throw new Error('probe failed'); }, 1), /probe failed/);
});
