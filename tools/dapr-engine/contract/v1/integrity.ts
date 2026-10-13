import { canonicalDigest, sha256Digest } from "./canonical-json.ts";
import type { ArtifactRefV1, CheckpointV1, RetentionClass, Sha256Digest } from "./types.ts";

export type IntegrityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "artifact-size-mismatch" | "artifact-digest-mismatch"; readonly detail: string };

/** Verifies bytes against a declared size and digest on publish and on resolve. */
export function verifyArtifactBytes(
  bytes: Uint8Array,
  declared: Pick<ArtifactRefV1, "sizeBytes" | "sha256">,
): IntegrityResult {
  if (bytes.byteLength !== declared.sizeBytes) {
    return { ok: false, code: "artifact-size-mismatch", detail: `Expected ${declared.sizeBytes} bytes, found ${bytes.byteLength}` };
  }
  const actual = sha256Digest(bytes);
  if (actual !== declared.sha256) {
    return { ok: false, code: "artifact-digest-mismatch", detail: `Expected ${declared.sha256}, found ${actual}` };
  }
  return { ok: true };
}

export function computeCheckpointDigest(checkpoint: CheckpointV1): Sha256Digest {
  return canonicalDigest(checkpoint);
}

export interface RetentionCandidate {
  readonly artifactId: string;
  readonly retentionClass: RetentionClass;
  /** When the owning run became terminal; absent while the run is live. */
  readonly terminalAt?: string;
}

export interface RetentionPlan {
  readonly deletable: readonly string[];
  readonly retained: readonly { readonly artifactId: string; readonly reason: "live-reference" | "not-expired" | "not-terminal" | "evidence-class" }[];
}

/**
 * Only expired terminal diagnostics without a live workflow, checkpoint,
 * approval, or review reference may be deleted.
 */
export function planRetention(
  candidates: readonly RetentionCandidate[],
  liveReferences: ReadonlySet<string>,
  now: Date,
  diagnosticRetentionMs: number,
): RetentionPlan {
  const deletable: string[] = [];
  const retained: { artifactId: string; reason: RetentionPlan["retained"][number]["reason"] }[] = [];
  for (const candidate of candidates) {
    if (liveReferences.has(candidate.artifactId)) retained.push({ artifactId: candidate.artifactId, reason: "live-reference" });
    else if (candidate.retentionClass !== "terminal-diagnostic") retained.push({ artifactId: candidate.artifactId, reason: "evidence-class" });
    else if (candidate.terminalAt === undefined) retained.push({ artifactId: candidate.artifactId, reason: "not-terminal" });
    else if (now.getTime() - Date.parse(candidate.terminalAt) < diagnosticRetentionMs) {
      retained.push({ artifactId: candidate.artifactId, reason: "not-expired" });
    } else deletable.push(candidate.artifactId);
  }
  return { deletable, retained };
}
