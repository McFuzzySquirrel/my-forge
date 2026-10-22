import type { ExecutionManifest } from "./types.ts";

export function prerequisites(manifest: ExecutionManifest, taskId: string): string[] {
  const entry = manifest.phases
    .flatMap((phase) => phase.tasks.map((task) => ({ phase, task })))
    .find((candidate) => candidate.task.id === taskId);
  if (!entry) return [];
  const phaseDependencies = (entry.phase.dependencies ?? []).flatMap((id) =>
    (manifest.phases.find((candidate) => candidate.id === id)?.tasks ?? []).map((task) => task.id));
  return [...new Set([...(entry.task.dependencies ?? []), ...phaseDependencies])];
}
