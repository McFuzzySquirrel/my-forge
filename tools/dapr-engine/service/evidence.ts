import type { ArtifactRefV1 } from "../contract/v1/index.ts";
import type { TaskCompletionRecordV1, TaskCompletionStore } from "../execution/task-completions.ts";
import type { ArtifactResolveResult } from "../storage/files/artifact-checkpoint-store.ts";
import type { RunServiceResult } from "./runs.ts";

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function reject(status: number, code: string, detail: string): RunServiceResult {
  return { ok: false, status, code, detail };
}

function refs(record: TaskCompletionRecordV1): readonly ArtifactRefV1[] {
  return [
    ...(record.workArtifact ? [record.workArtifact] : []),
    record.validationArtifact,
    record.bundleArtifact,
  ];
}

/**
 * Read-only view of durable task evidence. The runtime keeps artifacts and
 * completion records outside the repository, so the Console needs an explicit
 * service surface rather than scanning `docs/artifacts/`.
 */
export class CompletionEvidenceService {
  constructor(
    private readonly completions: Pick<TaskCompletionStore, "list">,
    private readonly artifacts: { resolveArtifact(ref: ArtifactRefV1): Promise<ArtifactResolveResult> },
  ) {}

  async list(repositoryId: string): Promise<RunServiceResult> {
    if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
      return reject(400, "invalid-repository", "repositoryId is invalid");
    }
    const records = await this.completions.list(repositoryId);
    const byTask = new Map<string, TaskCompletionRecordV1[]>();
    for (const record of records) {
      const current = byTask.get(record.taskId) ?? [];
      current.push(record);
      byTask.set(record.taskId, current);
    }
    return {
      ok: true,
      status: 200,
      body: {
        repositoryId,
        tasks: [...byTask.entries()]
          .map(([taskId, taskRecords]) => ({ taskId, records: taskRecords }))
          .sort((left, right) => left.taskId.localeCompare(right.taskId)),
        count: records.length,
      },
    };
  }

  async artifact(repositoryId: string, artifactId: string): Promise<RunServiceResult> {
    if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
      return reject(400, "invalid-repository", "repositoryId is invalid");
    }
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      return reject(400, "invalid-artifact", "artifactId is invalid");
    }
    const records = await this.completions.list(repositoryId);
    const ref = records.flatMap(refs).find((candidate) => candidate.artifactId === artifactId);
    if (!ref) return reject(404, "artifact-not-found", "No completion artifact matches that id for this repository");
    if (ref.sizeBytes > MAX_ARTIFACT_BYTES) {
      return reject(413, "artifact-too-large", `Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const resolved = await this.artifacts.resolveArtifact(ref);
    if (!resolved.ok) return reject(404, "artifact-unavailable", `Artifact is unavailable (${resolved.code})`);
    const bytes = Buffer.from(resolved.bytes);
    return {
      ok: true,
      status: 200,
      body: {
        ...ref,
        encoding: "base64",
        content: bytes.toString("base64"),
      },
    };
  }
}
