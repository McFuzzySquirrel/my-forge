/** Resolves manifest phase ids into the task ids accepted by a run submission. */

interface ManifestPhase {
  readonly id?: unknown;
  readonly tasks?: readonly unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parses a comma-separated phase list, preserving order and removing duplicates. */
export function parsePhaseIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * Returns every task in the selected phases in manifest order. Dependency
 * expansion remains the service's job, so prior phases are still added when
 * this list is submitted.
 */
export function resolvePhaseTaskIds(manifest: unknown, phaseIds: readonly string[]): string[] {
  if (phaseIds.length === 0) return [];
  if (!record(manifest) || !Array.isArray(manifest.phases)) {
    throw new Error("docs/EXECUTION-MANIFEST.json has no phase list.");
  }
  const phases = new Map<string, ManifestPhase>();
  for (const raw of manifest.phases) {
    if (!record(raw) || typeof raw.id !== "string" || !raw.id) {
      throw new Error("docs/EXECUTION-MANIFEST.json contains a phase without an id.");
    }
    if (phases.has(raw.id)) throw new Error(`docs/EXECUTION-MANIFEST.json contains duplicate phase '${raw.id}'.`);
    phases.set(raw.id, raw);
  }
  const requested = new Set<string>();
  for (const phaseId of phaseIds) {
    if (!phases.has(phaseId)) {
      const available = [...phases.keys()].join(", ") || "(none)";
      throw new Error(`Unknown phase '${phaseId}'. Available phases: ${available}.`);
    }
    requested.add(phaseId);
  }
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of manifest.phases) {
    const phase = raw as ManifestPhase;
    if (!requested.has(phase.id as string)) continue;
    if (!Array.isArray(phase.tasks)) throw new Error(`Phase '${String(phase.id)}' has no task list.`);
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.id !== "string" || !task.id) {
        throw new Error(`Phase '${String(phase.id)}' contains a task without an id.`);
      }
      if (!seen.has(task.id)) {
        seen.add(task.id);
        taskIds.push(task.id);
      }
    }
  }
  if (taskIds.length === 0) throw new Error(`Selected phase${phaseIds.length === 1 ? "" : "s"} contain no tasks.`);
  return taskIds;
}
