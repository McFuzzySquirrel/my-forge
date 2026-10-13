import { randomUUID } from "node:crypto";
import {
  SCHEMA_VERSION,
  computeManifestDigest,
  type ControlAction,
  type ControlRequestV1,
  type JsonValue,
  type ManifestSnapshotV1,
  type RunSubmissionV1,
} from "../../../contract/v1/index.ts";

/** Two phases: P2 depends on P1, and T3 also depends directly on T1. */
export function sampleManifest(): ManifestSnapshotV1 {
  return {
    version: "1.0",
    phases: [
      { id: "P1", tasks: [{ id: "T1" }, { id: "T2", dependencies: ["T1"] }] },
      { id: "P2", dependencies: ["P1"], tasks: [{ id: "T3", dependencies: ["T1"] }, { id: "T4" }] },
    ],
  };
}

export function submission(overrides: Partial<RunSubmissionV1> = {}): RunSubmissionV1 {
  const manifestSnapshot = overrides.manifestSnapshot ?? sampleManifest();
  return {
    schemaVersion: SCHEMA_VERSION,
    submissionKey: randomUUID(),
    repositoryId: "repo_fixture",
    targetRef: "refs/heads/main",
    manifestSnapshot,
    manifestDigest: computeManifestDigest(manifestSnapshot),
    selection: { mode: "auto", requestedTaskIds: [] },
    harness: { id: "stub", adapterVersion: "1" },
    configuration: {
      settings: { maxRetries: 2, taskTimeoutMs: 60_000, autoCommit: true },
      secretRefs: { OPENAI_API_KEY: { ref: "secret://forge/openai", version: "3" } },
    },
    workflowDefinitionVersion: "forge-run@1.0.0",
    ...overrides,
  };
}

export function control(
  runId: string,
  action: ControlAction,
  payload: Record<string, JsonValue> = {},
  controlId = randomUUID(),
): ControlRequestV1 {
  return { schemaVersion: SCHEMA_VERSION, controlId, runId, action, payload };
}

export const OPERATOR = { operatorId: "operator@example.test", role: "operator" } as const;
