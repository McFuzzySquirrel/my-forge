// ─── Per-run executor choice ──────────────────────────────────────────────────
//
// The Console keeps one executor choice for the next run. It is shared by the
// views that can start a run (Overview and Tasks) so a selection made on one
// page is not silently ignored on another. `docs/engine-config.json` supplies
// the initial value only; saving a new default is an explicit separate action.

import type { Executor, Summary } from "./types.js";

let choice: Executor | null = null;
let choiceRepo: string | null = null;

/** The executor for the next run: the operator's choice, else the saved default. */
export function executorFor(summary: Summary | null): Executor {
  const repoRoot = summary?.repoRoot ?? null;
  if (repoRoot !== choiceRepo) {
    choice = null;
    choiceRepo = repoRoot;
  }
  return choice ?? (summary?.hostExecution === true ? "host" : "worker");
}

export function setExecutorChoice(executor: Executor): void {
  choice = executor;
}
