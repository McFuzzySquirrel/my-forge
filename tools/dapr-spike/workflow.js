import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateInput(input) {
  if (!input || !Number.isInteger(input.timerSeconds) ||
      input.timerSeconds < 1 || input.timerSeconds > 600) {
    throw new Error('timerSeconds must be an integer from 1 to 600');
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.runId ?? '')) {
    throw new Error('runId must contain 1–100 letters, digits, underscores or hyphens');
  }
  return input;
}

/** @param {import('@dapr/dapr').WorkflowContext} context */
export async function* approvalWorkflow(context, input) {
  validateInput(input);
  const artifact = yield context.callActivity('stubActivity', { runId: input.runId });
  context.setCustomStatus('timer');
  yield context.createTimer(input.timerSeconds);
  context.setCustomStatus('approval');
  const approval = yield context.waitForExternalEvent('approval');
  if (approval !== true) throw new Error('Approval must be true');
  context.setCustomStatus('completed');
  return { artifact, approved: true, definitionVersion: 1 };
}

export async function persistArtifact(directory, runId) {
  validateInput({ runId, timerSeconds: 1 });
  await mkdir(directory, { recursive: true });
  const content = JSON.stringify({ version: 1, runId, result: 'stub-completed' });
  const digest = createHash('sha256').update(content).digest('hex');
  const name = `${runId}.json`;
  const target = join(directory, name);
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(target, 'utf8') !== content) throw new Error('Artifact receipt conflict');
  }
  return { key: name, sha256: digest, bytes: Buffer.byteLength(content) };
}

export async function stubActivity(_context, input) {
  return persistArtifact(process.env.SPIKE_ARTIFACT_DIR ?? '/artifacts', input.runId);
}
