import { constants } from "node:fs";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalDigest,
  canonicalJson,
  SCHEMA_VERSION,
  sha256Digest,
  verifyArtifactBytes,
  type ArtifactRefV1,
  type CheckpointChangeV1,
  type DependencyLockfileV1,
  type OperationReceiptV1,
  type TaskCheckpointV1,
  type ToolchainEntryV1,
  type Sha256Digest,
} from "../../contract/v1/index.ts";

export type ArtifactPublishResult =
  | { readonly ok: true; readonly ref: ArtifactRefV1 }
  | { readonly ok: false; readonly code: "artifact-size-mismatch" | "artifact-digest-mismatch" | "artifact-missing" };

export type ArtifactResolveResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: "artifact-missing" | "artifact-size-mismatch" | "artifact-digest-mismatch" };

export type TaskCheckpointResult =
  | { readonly ok: true; readonly digest: Sha256Digest; readonly checkpoint: TaskCheckpointV1 }
  | { readonly ok: false; readonly code: "checkpoint-integrity-failure" | "checkpoint-missing"; readonly failures: readonly string[] };

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_MODES = new Set(["100644", "100755", "120000", "160000"]);

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestHex(digest: string): string | undefined {
  return SHA256_PATTERN.test(digest) ? digest.slice("sha256:".length) : undefined;
}

function artifactIdFor(
  ref: Pick<ArtifactRefV1, "schemaVersion" | "uri" | "mediaType" | "sizeBytes" | "sha256" | "sensitivity" | "retentionClass">,
): string {
  return `art_${canonicalDigest(ref).slice("sha256:".length)}`;
}

function objectPath(root: string, namespace: "objects" | "checkpoints", digest: string): string {
  const hex = digestHex(digest);
  if (!hex) throw new TypeError("Expected a canonical sha256 digest");
  const suffix = namespace === "objects" ? hex.slice(2) : `${hex.slice(2)}.json`;
  return join(root, namespace, "sha256", hex.slice(0, 2), suffix);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readImmutableFile(path: string): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function writeImmutableFile(path: string, bytes: Uint8Array): Promise<boolean> {
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directoryPath, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    try {
      await temporaryFile.writeFile(bytes);
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }

    try {
      await link(temporaryPath, path);
      await syncDirectory(directoryPath);
      return true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readImmutableFile(path);
      return existing !== undefined && existing.equals(Buffer.from(bytes));
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isArtifactRef(value: unknown): value is ArtifactRefV1 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === SCHEMA_VERSION &&
    typeof value.artifactId === "string" &&
    typeof value.uri === "string" &&
    typeof value.mediaType === "string" &&
    Number.isSafeInteger(value.sizeBytes) &&
    (value.sizeBytes as number) >= 0 &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    (value.sensitivity === undefined || value.sensitivity === "normal" || value.sensitivity === "sensitive") &&
    (value.retentionClass === undefined || value.retentionClass === "terminal-diagnostic" || value.retentionClass === "checkpoint-evidence");
}

function isCheckpointChange(value: unknown): value is CheckpointChangeV1 {
  if (!isRecord(value)) return false;
  return typeof value.path === "string" &&
    (value.change === "added" || value.change === "modified" || value.change === "deleted") &&
    typeof value.binary === "boolean" &&
    (value.baseBlobOid === undefined || typeof value.baseBlobOid === "string") &&
    (value.resultBlobOid === undefined || typeof value.resultBlobOid === "string") &&
    (value.baseMode === undefined || typeof value.baseMode === "string") &&
    (value.resultMode === undefined || typeof value.resultMode === "string");
}

function isToolchainEntry(value: unknown): value is ToolchainEntryV1 {
  return isRecord(value) && typeof value.name === "string" && typeof value.version === "string";
}

function isDependencyLockfile(value: unknown): value is DependencyLockfileV1 {
  return isRecord(value) &&
    typeof value.path === "string" &&
    isArtifactRef(value.artifact);
}

function isTaskCheckpoint(value: unknown): value is TaskCheckpointV1 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === SCHEMA_VERSION &&
    typeof value.runId === "string" &&
    typeof value.manifestDigest === "string" &&
    SHA256_PATTERN.test(value.manifestDigest) &&
    (value.parentCheckpointDigest === undefined ||
      (typeof value.parentCheckpointDigest === "string" && SHA256_PATTERN.test(value.parentCheckpointDigest))) &&
    Array.isArray(value.artifacts) && value.artifacts.every(isArtifactRef) &&
    typeof value.gitTreeId === "string" &&
    typeof value.baseRevision === "string" &&
    Array.isArray(value.changes) && value.changes.every(isCheckpointChange) &&
    Array.isArray(value.gitObjectIds) && value.gitObjectIds.every((id) => typeof id === "string") &&
    isArtifactRef(value.gitObjectBundle) &&
    Array.isArray(value.validationEvidence) && value.validationEvidence.every(isArtifactRef) &&
    Array.isArray(value.toolchain) && value.toolchain.every(isToolchainEntry) &&
    Array.isArray(value.dependencyLockfiles) && value.dependencyLockfiles.every(isDependencyLockfile);
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validateCheckpoint(checkpoint: TaskCheckpointV1): string[] {
  const failures: string[] = [];
  const artifactReferences = new Set(checkpoint.artifacts.map(artifactReferenceKey));
  const isIncluded = (artifact: ArtifactRefV1) => artifactReferences.has(artifactReferenceKey(artifact));
  if (artifactReferences.size !== checkpoint.artifacts.length) failures.push("artifacts must not contain duplicate references");

  if (!checkpoint.runId) failures.push("runId is required");
  if (!SHA256_PATTERN.test(checkpoint.manifestDigest)) failures.push("manifestDigest is invalid");
  if (checkpoint.schemaVersion !== SCHEMA_VERSION) failures.push("checkpoint schema version is unsupported");
  if (
    checkpoint.parentCheckpointDigest !== undefined &&
    !SHA256_PATTERN.test(checkpoint.parentCheckpointDigest)
  ) {
    failures.push("parentCheckpointDigest is invalid");
  }
  if (!GIT_OID_PATTERN.test(checkpoint.baseRevision)) failures.push("baseRevision is not a valid Git object ID");
  if (!GIT_OID_PATTERN.test(checkpoint.gitTreeId)) failures.push("gitTreeId is not a valid Git object ID");
  if (!checkpoint.gitObjectIds.includes(checkpoint.gitTreeId)) failures.push("gitObjectIds must include gitTreeId");
  if (!checkpoint.gitObjectIds.includes(checkpoint.baseRevision)) failures.push("gitObjectIds must include baseRevision");
  if (checkpoint.gitObjectIds.length === 0 || checkpoint.gitObjectIds.some((id) => !GIT_OID_PATTERN.test(id))) {
    failures.push("gitObjectIds must contain valid Git object IDs");
  }
  if (new Set(checkpoint.gitObjectIds).size !== checkpoint.gitObjectIds.length) {
    failures.push("gitObjectIds must not contain duplicates");
  }
  if (!isIncluded(checkpoint.gitObjectBundle)) failures.push("gitObjectBundle must be included in artifacts");
  if (checkpoint.validationEvidence.length === 0) failures.push("at least one validation evidence artifact is required");
  if (checkpoint.validationEvidence.some((artifact) => !isIncluded(artifact))) {
    failures.push("all validation evidence artifacts must be included in artifacts");
  }
  if (checkpoint.toolchain.length === 0 || checkpoint.toolchain.some((entry) => !entry.name || !entry.version)) {
    failures.push("toolchain entries must include a name and version");
  }
  if (new Set(checkpoint.toolchain.map((entry) => entry.name)).size !== checkpoint.toolchain.length) {
    failures.push("toolchain names must be unique");
  }
  if (checkpoint.dependencyLockfiles.some((file) => !safeRelativePath(file.path))) {
    failures.push("dependency lockfile paths must be safe relative paths");
  }
  if (checkpoint.dependencyLockfiles.some((file) => !isIncluded(file.artifact))) {
    failures.push("dependency lockfile artifacts must be included in artifacts");
  }
  if (new Set(checkpoint.dependencyLockfiles.map((file) => file.path)).size !== checkpoint.dependencyLockfiles.length) {
    failures.push("dependency lockfile paths must be unique");
  }

  const changedPaths = new Set<string>();
  for (const change of checkpoint.changes) {
    if (!safeRelativePath(change.path)) failures.push(`unsafe change path: ${change.path}`);
    if (changedPaths.has(change.path)) failures.push(`duplicate change path: ${change.path}`);
    changedPaths.add(change.path);

    const baseRequired = change.change !== "added";
    const resultRequired = change.change !== "deleted";
    if (baseRequired !== (change.baseBlobOid !== undefined) ||
        resultRequired !== (change.resultBlobOid !== undefined) ||
        (change.baseBlobOid !== undefined && !GIT_OID_PATTERN.test(change.baseBlobOid)) ||
        (change.resultBlobOid !== undefined && !GIT_OID_PATTERN.test(change.resultBlobOid))) {
      failures.push(`invalid blob object IDs for change: ${change.path}`);
    }
    if (baseRequired !== (change.baseMode !== undefined) ||
        resultRequired !== (change.resultMode !== undefined) ||
        (change.baseMode !== undefined && !GIT_MODES.has(change.baseMode)) ||
        (change.resultMode !== undefined && !GIT_MODES.has(change.resultMode))) {
      failures.push(`invalid file modes for change: ${change.path}`);
    }
    if (
      (change.baseBlobOid !== undefined && !checkpoint.gitObjectIds.includes(change.baseBlobOid)) ||
      (change.resultBlobOid !== undefined && !checkpoint.gitObjectIds.includes(change.resultBlobOid))
    ) {
      failures.push(`change object IDs must be included in gitObjectIds: ${change.path}`);
    }
  }
  return failures;
}

function artifactReferenceKey(ref: ArtifactRefV1): string {
  return `${ref.artifactId}\u0000${ref.sha256}`;
}

export class FileArtifactCheckpointStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) throw new TypeError("Artifact storage root must be an absolute path");
    this.root = resolve(rootDirectory);
  }

  async publishArtifact(
    bytes: Uint8Array,
    declared: Pick<ArtifactRefV1, "mediaType" | "sizeBytes" | "sha256"> &
      Partial<Pick<ArtifactRefV1, "sensitivity" | "retentionClass">>,
  ): Promise<ArtifactPublishResult> {
    const integrity = verifyArtifactBytes(bytes, declared);
    if (!integrity.ok) return { ok: false, code: integrity.code };

    const immutableBytes = Buffer.from(bytes);
    const hex = declared.sha256.slice("sha256:".length);
    const refFields = {
      schemaVersion: SCHEMA_VERSION,
      uri: `artifact://sha256/${hex}`,
      mediaType: declared.mediaType,
      sizeBytes: declared.sizeBytes,
      sha256: declared.sha256,
      ...(declared.sensitivity ? { sensitivity: declared.sensitivity } : {}),
      ...(declared.retentionClass ? { retentionClass: declared.retentionClass } : {}),
    };
    const ref: ArtifactRefV1 = { ...refFields, artifactId: artifactIdFor(refFields) };
    const target = objectPath(this.root, "objects", ref.sha256);
    if (!await writeImmutableFile(target, immutableBytes)) {
      return { ok: false, code: "artifact-digest-mismatch" };
    }

    const stored = await readImmutableFile(target);
    if (!stored) return { ok: false, code: "artifact-missing" } as never;
    const storedIntegrity = verifyArtifactBytes(stored, ref);
    return storedIntegrity.ok
      ? { ok: true, ref }
      : { ok: false, code: storedIntegrity.code };
  }

  async resolveArtifact(ref: ArtifactRefV1): Promise<ArtifactResolveResult> {
    const hex = digestHex(ref.sha256);
    if (
      !hex ||
      ref.uri !== `artifact://sha256/${hex}` ||
      ref.artifactId !== artifactIdFor({
        schemaVersion: ref.schemaVersion,
        uri: ref.uri,
        mediaType: ref.mediaType,
        sizeBytes: ref.sizeBytes,
        sha256: ref.sha256,
        ...(ref.sensitivity ? { sensitivity: ref.sensitivity } : {}),
        ...(ref.retentionClass ? { retentionClass: ref.retentionClass } : {}),
      })
    ) {
      return { ok: false, code: "artifact-digest-mismatch" };
    }
    if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0) {
      return { ok: false, code: "artifact-size-mismatch" };
    }
    const bytes = await readImmutableFile(objectPath(this.root, "objects", ref.sha256));
    if (!bytes) return { ok: false, code: "artifact-missing" };
    const integrity = verifyArtifactBytes(bytes, ref);
    return integrity.ok
      ? { ok: true, bytes: Uint8Array.from(bytes) }
      : { ok: false, code: integrity.code };
  }

  async publishCheckpoint(checkpoint: TaskCheckpointV1): Promise<TaskCheckpointResult> {
    const snapshot = structuredClone(checkpoint);
    const failures = validateCheckpoint(snapshot);
    for (const ref of snapshot.artifacts) {
      const resolved = await this.resolveArtifact(ref);
      if (!resolved.ok) failures.push(`${ref.artifactId}: ${resolved.code}`);
    }
    if (failures.length > 0) {
      return { ok: false, code: "checkpoint-integrity-failure", failures };
    }

    const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
    const digest = sha256Digest(bytes);
    const target = objectPath(this.root, "checkpoints", digest);
    if (!await writeImmutableFile(target, bytes)) {
      return { ok: false, code: "checkpoint-integrity-failure", failures: ["existing checkpoint bytes conflict with their digest"] };
    }
    return this.resolveCheckpoint(digest);
  }

  async resolveCheckpoint(digest: Sha256Digest): Promise<TaskCheckpointResult> {
    if (!digestHex(digest)) {
      return { ok: false, code: "checkpoint-integrity-failure", failures: ["invalid checkpoint digest"] };
    }
    const bytes = await readImmutableFile(objectPath(this.root, "checkpoints", digest));
    if (!bytes) return { ok: false, code: "checkpoint-missing", failures: [] };
    if (sha256Digest(bytes) !== digest) {
      return { ok: false, code: "checkpoint-integrity-failure", failures: ["checkpoint digest mismatch"] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ok: false, code: "checkpoint-integrity-failure", failures: ["checkpoint JSON is invalid"] };
      }
      throw error;
    }
    if (!isTaskCheckpoint(parsed) || canonicalDigest(parsed) !== digest) {
      return { ok: false, code: "checkpoint-integrity-failure", failures: ["checkpoint schema or canonical digest is invalid"] };
    }

    const failures = validateCheckpoint(parsed);
    for (const ref of parsed.artifacts) {
      const resolved = await this.resolveArtifact(ref);
      if (!resolved.ok) failures.push(`${ref.artifactId}: ${resolved.code}`);
    }
    return failures.length > 0
      ? { ok: false, code: "checkpoint-integrity-failure", failures }
      : { ok: true, digest, checkpoint: structuredClone(parsed) };
  }
}
