import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactRefV1, Sha256Digest } from "../contract/v1/index.ts";
import type { ArtifactResolveResult } from "../storage/files/artifact-checkpoint-store.ts";
import type { Artifact } from "./types.ts";
import { ArtifactStore } from "./artifacts.ts";
import { taskFileId } from "./task-execution.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TASK_ID_PATTERN = /^[^\0/]{1,200}$/;

export interface TaskCompletionRecordV1 {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly taskId: string;
  readonly runId: string;
  readonly commitSha: string;
  readonly baseRevision: string;
  readonly checkpointDigest: Sha256Digest;
  readonly workArtifact?: ArtifactRefV1;
  readonly validationArtifact: ArtifactRefV1;
  readonly bundleArtifact: ArtifactRefV1;
  readonly outputFiles: readonly string[];
  readonly validationCommands: readonly string[];
  readonly handoffDigest: Sha256Digest;
  readonly completedAt: string;
}

export interface ResolveTaskCompletionOptions {
  readonly repositoryId: string;
  readonly taskId: string;
  readonly repositoryRoot: string;
  /** The target ref head at the start of the new run. */
  readonly head: string;
}

export interface HydrateTaskCompletionsOptions extends Omit<ResolveTaskCompletionOptions, "taskId"> {
  readonly taskIds: readonly string[];
  readonly resolveArtifact: (ref: ArtifactRefV1) => Promise<ArtifactResolveResult>;
}

interface CompletionFileV1 {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly taskId: string;
  readonly records: readonly TaskCompletionRecordV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRef(value: unknown): value is ArtifactRefV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.artifactId === "string" && value.artifactId.length > 0
    && typeof value.uri === "string" && value.uri.length > 0
    && typeof value.mediaType === "string" && value.mediaType.length > 0
    && Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 0
    && typeof value.sha256 === "string" && DIGEST_PATTERN.test(value.sha256);
}

function isRecordV1(value: unknown): value is TaskCompletionRecordV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(value.repositoryId)
    && typeof value.targetRef === "string" && value.targetRef.startsWith("refs/heads/")
    && typeof value.taskId === "string" && TASK_ID_PATTERN.test(value.taskId)
    && typeof value.runId === "string" && value.runId.length > 0
    && typeof value.commitSha === "string" && GIT_REVISION_PATTERN.test(value.commitSha)
    && typeof value.baseRevision === "string" && GIT_REVISION_PATTERN.test(value.baseRevision)
    && typeof value.checkpointDigest === "string" && DIGEST_PATTERN.test(value.checkpointDigest)
    && (value.workArtifact === undefined || isRef(value.workArtifact))
    && isRef(value.validationArtifact)
    && isRef(value.bundleArtifact)
    && Array.isArray(value.outputFiles) && value.outputFiles.every((entry) => typeof entry === "string")
    && Array.isArray(value.validationCommands) && value.validationCommands.every((entry) => typeof entry === "string")
    && typeof value.handoffDigest === "string" && DIGEST_PATTERN.test(value.handoffDigest)
    && typeof value.completedAt === "string" && !Number.isNaN(Date.parse(value.completedAt));
}

function validateRecord(record: TaskCompletionRecordV1): void {
  if (!isRecordV1(record)) throw new TypeError("Task completion record is invalid");
}

function repositoryDirectory(root: string, repositoryId: string): string {
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) throw new TypeError("Invalid repository ID");
  return join(root, repositoryId);
}

function completionFile(root: string, repositoryId: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new TypeError("Invalid task ID");
  return join(repositoryDirectory(root, repositoryId), `${taskFileId(taskId)}.json`);
}

async function readCompletionFile(file: string, repositoryId: string, taskId: string): Promise<CompletionFileV1> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, repositoryId, taskId, records: [] };
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.repositoryId !== repositoryId
    || parsed.taskId !== taskId
    || !Array.isArray(parsed.records)
    || !parsed.records.every(isRecordV1)) {
    throw new Error(`Task completion file is invalid: ${file}`);
  }
  return parsed as unknown as CompletionFileV1;
}

async function writeCompletionFile(file: string, value: CompletionFileV1): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function isAncestor(repositoryRoot: string, ancestor: string, head: string): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "-c", `safe.directory=${repositoryRoot}`,
      "merge-base", "--is-ancestor", ancestor, head,
    ], { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (Number(code) === 1) return false;
    throw error;
  }
}

/**
 * Durable index of integrated tasks. The host runner deletes its disposable
 * clone and the service keeps each run's artifacts run-local, so a later run
 * needs an explicit completion record to skip an already-integrated task and
 * to hydrate that task's work artifact for its dependants.
 */
export interface TaskCompletionStore {
  record(record: TaskCompletionRecordV1): Promise<void>;
  resolve(options: ResolveTaskCompletionOptions): Promise<TaskCompletionRecordV1 | undefined>;
  /** All durable completions for one repository, newest first. */
  list(repositoryId: string): Promise<readonly TaskCompletionRecordV1[]>;
  hydrate(artifactStore: ArtifactStore, options: HydrateTaskCompletionsOptions): Promise<void>;
}

export class FileTaskCompletionStore implements TaskCompletionStore {
  constructor(private readonly root: string) {}

  async record(record: TaskCompletionRecordV1): Promise<void> {
    validateRecord(record);
    const file = completionFile(this.root, record.repositoryId, record.taskId);
    const current = await readCompletionFile(file, record.repositoryId, record.taskId);
    if (current.records.some((entry) =>
      entry.runId === record.runId && entry.commitSha === record.commitSha)) return;
    const records = [...current.records, record]
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    await writeCompletionFile(file, {
      schemaVersion: 1,
      repositoryId: record.repositoryId,
      taskId: record.taskId,
      records,
    });
  }

  async resolve(options: ResolveTaskCompletionOptions): Promise<TaskCompletionRecordV1 | undefined> {
    if (!GIT_REVISION_PATTERN.test(options.head)) throw new TypeError("Target head must be a full Git object ID");
    const file = completionFile(this.root, options.repositoryId, options.taskId);
    const current = await readCompletionFile(file, options.repositoryId, options.taskId);
    let selected: TaskCompletionRecordV1 | undefined;
    for (const record of current.records) {
      if (record.repositoryId !== options.repositoryId || record.taskId !== options.taskId) continue;
      if (!(await isAncestor(options.repositoryRoot, record.commitSha, options.head))) continue;
      if (!selected || record.completedAt > selected.completedAt) selected = record;
    }
    return selected;
  }

  async list(repositoryId: string): Promise<readonly TaskCompletionRecordV1[]> {
    if (!REPOSITORY_ID_PATTERN.test(repositoryId)) throw new TypeError("Invalid repository ID");
    const directory = repositoryDirectory(this.root, repositoryId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: TaskCompletionRecordV1[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const file = join(directory, entry);
      const text = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)
        || parsed.schemaVersion !== 1
        || parsed.repositoryId !== repositoryId
        || typeof parsed.taskId !== "string"
        || !Array.isArray(parsed.records)
        || !parsed.records.every(isRecordV1)) {
        throw new Error(`Task completion file is invalid: ${file}`);
      }
      for (const record of parsed.records) {
        if (record.repositoryId === repositoryId && record.taskId === parsed.taskId) records.push(record);
      }
    }
    return records.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async hydrate(artifactStore: ArtifactStore, options: HydrateTaskCompletionsOptions): Promise<void> {
    const existing = new Set(artifactStore.readAll().map((artifact) => artifact.taskId));
    for (const taskId of options.taskIds) {
      if (existing.has(taskId)) continue;
      const completion = await this.resolve({ ...options, taskId });
      if (!completion?.workArtifact) continue;
      const resolved = await options.resolveArtifact(completion.workArtifact);
      if (!resolved.ok) {
        throw new Error(`Completion artifact for '${taskId}' is unavailable: ${resolved.code}`);
      }
      const parsed: unknown = JSON.parse(Buffer.from(resolved.bytes).toString("utf8"));
      if (!isRecord(parsed)
        || typeof parsed.artifactId !== "string" || parsed.artifactId.length === 0
        || typeof parsed.type !== "string" || parsed.type.length === 0
        || parsed.taskId !== taskId
        || typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt))
        || !isRecord(parsed.payload)) {
        throw new Error(`Completion artifact for '${taskId}' is not a valid work artifact`);
      }
      artifactStore.write(parsed as unknown as Omit<Artifact, "artifactId" | "createdAt"> & Partial<Pick<Artifact, "artifactId" | "createdAt">>);
      existing.add(taskId);
    }
  }
}
