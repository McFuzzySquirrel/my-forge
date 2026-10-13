import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, WorkflowActivityContext, WorkflowContext } from "@dapr/dapr";

export interface WorkflowInput {
  runId: string;
  timerSeconds: number;
}

export interface ActivityInput {
  runId: string;
}

export interface ArtifactReceipt {
  key: string;
  sha256: string;
  bytes: number;
}

export interface WorkflowOutput {
  artifact: ArtifactReceipt;
  approved: true;
  definitionVersion: 1;
}

export function validateInput(input: unknown): WorkflowInput {
  if (!input || typeof input !== "object" || !("timerSeconds" in input) || !("runId" in input)) {
    throw new Error("workflow input must be an object");
  }
  const { timerSeconds, runId } = input;
  if (typeof timerSeconds !== "number" || !Number.isInteger(timerSeconds) ||
      timerSeconds < 1 || timerSeconds > 600) {
    throw new Error("timerSeconds must be an integer from 1 to 600");
  }
  validateRunId(runId);
  return { runId, timerSeconds };
}

function validateRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
    throw new Error("runId must contain 1–100 letters, digits, underscores or hyphens");
  }
}

function isArtifactReceipt(value: unknown): value is ArtifactReceipt {
  return Boolean(value && typeof value === "object"
    && "key" in value && typeof value.key === "string"
    && "sha256" in value && typeof value.sha256 === "string"
    && "bytes" in value && typeof value.bytes === "number");
}

export async function* approvalWorkflow(
  context: WorkflowContext,
  input: WorkflowInput,
): AsyncGenerator<Task<unknown>, WorkflowOutput, unknown> {
  const validatedInput = validateInput(input);
  const artifactResult = yield context.callActivity("stubActivity", { runId: validatedInput.runId });
  if (!isArtifactReceipt(artifactResult)) {
    throw new Error("Stub activity returned an invalid artifact receipt");
  }
  context.setCustomStatus("timer");
  yield context.createTimer(input.timerSeconds);
  context.setCustomStatus("approval");
  const approval = yield context.waitForExternalEvent("approval");
  if (approval !== true) throw new Error("Approval must be true");
  context.setCustomStatus("completed");
  return { artifact: artifactResult, approved: true, definitionVersion: 1 };
}

export async function persistArtifact(directory: string, runId: string): Promise<ArtifactReceipt> {
  validateInput({ runId, timerSeconds: 1 });
  await mkdir(directory, { recursive: true });
  const content = JSON.stringify({ version: 1, runId, result: "stub-completed" });
  const digest = createHash("sha256").update(content).digest("hex");
  const name = `${runId}.json`;
  const target = join(directory, name);
  try {
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(target, "utf8") !== content) throw new Error("Artifact receipt conflict");
  }
  return { key: name, sha256: digest, bytes: Buffer.byteLength(content) };
}

export async function stubActivity(
  _context: WorkflowActivityContext,
  input: ActivityInput,
): Promise<ArtifactReceipt> {
  return persistArtifact(process.env.SPIKE_ARTIFACT_DIR ?? "/artifacts", input.runId);
}
