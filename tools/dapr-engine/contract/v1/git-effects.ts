import { canonicalDigest } from "./canonical-json.ts";
import { SCHEMA_VERSION, type Sha256Digest } from "./types.ts";

/** The repository effect of one logical attempt; its digest is the receipt's effect digest. */
export interface GitIntegrationEffectV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly runId: string;
  readonly taskId: string;
  readonly logicalAttempt: number;
  readonly operationId: string;
  readonly expectedHead: string;
  readonly commitSha: string;
  readonly checkpointDigest: Sha256Digest;
}

export function gitIntegrationEffectDigest(effect: Omit<GitIntegrationEffectV1, "schemaVersion">): Sha256Digest {
  const record: GitIntegrationEffectV1 = {
    schemaVersion: SCHEMA_VERSION,
    repositoryId: effect.repositoryId,
    targetRef: effect.targetRef,
    runId: effect.runId,
    taskId: effect.taskId,
    logicalAttempt: effect.logicalAttempt,
    operationId: effect.operationId,
    expectedHead: effect.expectedHead,
    commitSha: effect.commitSha,
    checkpointDigest: effect.checkpointDigest,
  };
  return canonicalDigest(record);
}

export interface GitEffectPolicyInputV1 {
  /** The run's preserved `--auto-commit` setting. */
  readonly autoCommit: boolean;
  /** Whether the task's checkpoint was durably published and re-verified. */
  readonly checkpoint: "verified" | "unavailable";
  readonly commit: "not-requested" | "created" | "nothing-to-commit" | "failed";
  readonly integration: "not-attempted" | "integrated" | "rejected" | "ambiguous";
}

export type GitEffectDispositionV1 =
  | {
      readonly receipt: "accepted";
      readonly outcome: "integrated" | "checkpoint-only";
      readonly warning?: "commit-failed";
    }
  | { readonly receipt: "failed"; readonly reason: "uncheckpointed-effect" | "integration-rejected" }
  | { readonly receipt: "ambiguous"; readonly reason: "integration-ambiguous" | "integrated-checkpoint-unavailable" };

/**
 * Contract v1 §3 Git effect policy (P0 register: auto-commit and commit failure).
 * A task's work is acceptable only when its checkpoint is durable; disabled
 * auto-commit and a failed local commit leave the checkpoint as the recoverable
 * effect, while a rejected or ambiguous branch integration blocks success.
 */
export function resolveGitEffectPolicy(input: GitEffectPolicyInputV1): GitEffectDispositionV1 {
  if (input.integration === "ambiguous") return { receipt: "ambiguous", reason: "integration-ambiguous" };
  if (input.integration !== "not-attempted" && input.commit !== "created") {
    throw new TypeError("Branch integration requires a created commit");
  }
  if (input.checkpoint !== "verified") {
    return input.integration === "integrated"
      ? { receipt: "ambiguous", reason: "integrated-checkpoint-unavailable" }
      : { receipt: "failed", reason: "uncheckpointed-effect" };
  }

  if (!input.autoCommit) {
    if (input.commit !== "not-requested") throw new TypeError("Disabled auto-commit must not create a commit");
    return { receipt: "accepted", outcome: "checkpoint-only" };
  }
  switch (input.commit) {
    case "not-requested":
      throw new TypeError("Enabled auto-commit must report its commit outcome");
    case "nothing-to-commit":
      return { receipt: "accepted", outcome: "checkpoint-only" };
    case "failed":
      return { receipt: "accepted", outcome: "checkpoint-only", warning: "commit-failed" };
    case "created":
      if (input.integration === "integrated") return { receipt: "accepted", outcome: "integrated" };
      if (input.integration === "rejected") return { receipt: "failed", reason: "integration-rejected" };
      throw new TypeError("A created auto-commit must be integrated or rejected before acceptance");
  }
}
