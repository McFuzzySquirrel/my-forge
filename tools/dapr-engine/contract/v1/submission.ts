import { canonicalDigest } from "./canonical-json.ts";
import {
  SCHEMA_VERSION,
  type ManifestSnapshotV1,
  type RunSubmissionV1,
  type Sha256Digest,
  type SubmissionRejectionCode,
} from "./types.ts";

export type SubmissionValidation =
  | {
    readonly ok: true;
    readonly manifestDigest: Sha256Digest;
    readonly snapshotDigest: Sha256Digest;
    readonly effectiveTaskIds: readonly string[];
  }
  | { readonly ok: false; readonly code: SubmissionRejectionCode; readonly detail: string };

export function computeManifestDigest(snapshot: ManifestSnapshotV1): Sha256Digest {
  return canonicalDigest(snapshot);
}

/**
 * Identity of everything that interprets a run except the caller's idempotency
 * key: reuse of a key is a conflict whenever this digest differs.
 */
export function computeSnapshotDigest(submission: RunSubmissionV1, manifestDigest: Sha256Digest): Sha256Digest {
  return canonicalDigest({
    schemaVersion: submission.schemaVersion,
    repositoryId: submission.repositoryId,
    targetRef: submission.targetRef,
    manifestDigest,
    selection: { mode: submission.selection.mode, requestedTaskIds: submission.selection.requestedTaskIds },
    harness: submission.harness,
    configuration: submission.configuration,
    workflowDefinitionVersion: submission.workflowDefinitionVersion,
  });
}

const SECRET_NAME = /(^|_)(api_?key|secret|password|passwd|token|credentials?|private_?key|auth)($|_)/;

function normalizeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s.]+/g, "_").toLowerCase();
}

/**
 * Paths of string values stored under secret-like names anywhere in the
 * submission, excluding `configuration.secretRefs`, which carries identifiers.
 */
export function findSecretValuePaths(submission: RunSubmissionV1): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string, name: string | null): void => {
    if (typeof value === "string") {
      if (name !== null && value.length > 0 && SECRET_NAME.test(normalizeName(name))) found.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, name));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (path === "$.configuration" && key === "secretRefs") continue;
        visit(child, `${path}.${key}`, key);
      }
    }
  };
  visit(submission, "$", null);
  return found;
}

/**
 * Dependency-expanded selection in manifest order. Mirrors the legacy rule:
 * direct task dependencies plus every task of each depended-on phase,
 * transitively. Unlike the legacy engine, unknown IDs are rejected.
 */
export function expandSelection(
  manifest: ManifestSnapshotV1,
  mode: "auto" | "manual",
  requestedTaskIds: readonly string[],
): { ok: true; effectiveTaskIds: string[] } | { ok: false; code: SubmissionRejectionCode; detail: string } {
  const order: string[] = [];
  const taskPhase = new Map<string, string>();
  const taskDependencies = new Map<string, readonly string[]>();
  const phaseTasks = new Map<string, string[]>();
  const phaseDependencies = new Map<string, readonly string[]>();
  for (const phase of manifest.phases) {
    if (phaseTasks.has(phase.id)) return { ok: false, code: "invalid-submission", detail: `Duplicate phase '${phase.id}'` };
    phaseTasks.set(phase.id, phase.tasks.map((task) => task.id));
    phaseDependencies.set(phase.id, phase.dependencies ?? []);
    for (const task of phase.tasks) {
      if (taskPhase.has(task.id)) return { ok: false, code: "invalid-submission", detail: `Duplicate task '${task.id}'` };
      taskPhase.set(task.id, phase.id);
      taskDependencies.set(task.id, task.dependencies ?? []);
      order.push(task.id);
    }
  }

  const roots = mode === "auto" ? order : [...requestedTaskIds];
  if (mode === "manual" && roots.length === 0) {
    return { ok: false, code: "invalid-submission", detail: "Manual selection requires at least one task" };
  }
  for (const id of roots) {
    if (!taskPhase.has(id)) return { ok: false, code: "unknown-selected-task", detail: `Unknown selected task '${id}'` };
  }

  const selected = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    selected.add(id);
    for (const dependency of taskDependencies.get(id) ?? []) {
      if (!taskPhase.has(dependency)) {
        return { ok: false, code: "unresolved-dependency", detail: `Task '${id}' depends on unknown task '${dependency}'` };
      }
      pending.push(dependency);
    }
    const phaseId = taskPhase.get(id)!;
    for (const dependencyPhase of phaseDependencies.get(phaseId) ?? []) {
      const tasks = phaseTasks.get(dependencyPhase);
      if (!tasks) {
        return { ok: false, code: "unresolved-dependency", detail: `Phase '${phaseId}' depends on unknown phase '${dependencyPhase}'` };
      }
      pending.push(...tasks);
    }
  }
  return { ok: true, effectiveTaskIds: order.filter((id) => selected.has(id)) };
}

/** Stateless v1 submission checks performed before a run can be accepted. */
export function validateSubmission(submission: RunSubmissionV1): SubmissionValidation {
  if ((submission as { schemaVersion: unknown }).schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: "unsupported-schema-version", detail: "Only schemaVersion 1 is supported" };
  }
  for (const field of ["submissionKey", "repositoryId", "targetRef", "workflowDefinitionVersion"] as const) {
    if (typeof submission[field] !== "string" || submission[field].length === 0) {
      return { ok: false, code: "invalid-submission", detail: `Missing ${field}` };
    }
  }
  const secretPaths = findSecretValuePaths(submission);
  if (secretPaths.length > 0) {
    return { ok: false, code: "secret-value-in-snapshot", detail: `Secret-like values at ${secretPaths.join(", ")}` };
  }
  const manifestDigest = computeManifestDigest(submission.manifestSnapshot);
  if (submission.manifestDigest !== manifestDigest) {
    return { ok: false, code: "manifest-digest-mismatch", detail: "Declared manifestDigest does not match the snapshot" };
  }
  const selection = expandSelection(submission.manifestSnapshot, submission.selection.mode, submission.selection.requestedTaskIds);
  if (!selection.ok) return selection;
  return {
    ok: true,
    manifestDigest,
    snapshotDigest: computeSnapshotDigest(submission, manifestDigest),
    effectiveTaskIds: selection.effectiveTaskIds,
  };
}
