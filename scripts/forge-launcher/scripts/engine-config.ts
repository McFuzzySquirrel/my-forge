import fs from "node:fs";
import path from "node:path";

/**
 * Persisted run configuration (docs/engine-config.json). The interactive
 * launcher writes the engine options chosen in `configureEngineOptions` here so
 * `forge-launcher resume` / monitor commands rebuild the engine invocation with
 * the same concurrency / retries / viz settings instead of the
 * minimal `--harness`-only command.
 */

export interface PersistedEngineConfig {
  harness: string;
  granularity: string;
  concurrency: string;
  taskTimeoutMs: string;
  maxRetries: string;
  viz: boolean;
  vizPort: string;
  /** Auto-commit after each completed task; absent means the engine default (on). */
  autoCommit?: boolean;
  /** Stream harness CLI activity into docs/forge.log; absent means the engine default (off). */
  logHarnessActivity?: boolean;
  /**
   * Explicit executor choice. Absent means the temporary host-runner default.
   * `hostExecution` is retained for older Console/launcher versions.
   */
  executor?: EngineExecutor;
  /** Run selected local harness CLIs on the host with full OS permissions. */
  hostExecution?: boolean;
  /** Execution mode for future run/resume commands. */
  executionMode?: ExecutionMode;
  /** How the selected task set was chosen for manual execution. */
  selectionScope?: SelectionScope;
  /** Explicit task ids to run when executionMode is "manual". */
  selectedTaskIds?: string[];
}

export type ExecutionMode = "auto" | "manual";
export type SelectionScope = "single" | "range" | "list" | "phase";
export type EngineExecutor = "host" | "worker";

export function assertEngineHarnessAvailable(harness: string): void {
  if (harness === "flowforge-kernel") {
    throw new Error("The flowforge-kernel harness has been retired. Select opencode, copilot, or claude for repository tasks (or openai for explicit text tasks), and update docs/engine-config.json or FORGE_ENGINE_HARNESS. Existing workforce artifacts are not deleted.");
  }
}

export function normaliseExecutionMode(value: unknown): ExecutionMode {
  return value === "manual" ? "manual" : "auto";
}

export function normaliseSelectionScope(value: unknown, selectedTaskIds: string[]): SelectionScope | null {
  if (selectedTaskIds.length === 0) return null;
  return value === "single" || value === "range" || value === "list" || value === "phase" ? value : "list";
}

export function normaliseExecutor(value: unknown): EngineExecutor | undefined {
  return value === "host" || value === "worker" ? value : undefined;
}

/** Host is the temporary default; only an explicit `worker` opts out. */
export function engineConfigExecutor(config: PersistedEngineConfig | null): EngineExecutor {
  return normaliseExecutor(config?.executor) === "worker" ? "worker" : "host";
}

export function normaliseSelectedTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id) unique.add(id);
  }
  return [...unique];
}

export function engineConfigPath(repoDir: string): string {
  return path.join(repoDir, "docs", "engine-config.json");
}

/** Returns the persisted config, or null when absent/invalid. */
export function loadEngineConfig(repoDir: string): PersistedEngineConfig | null {
  const file = engineConfigPath(repoDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PersistedEngineConfig;
  } catch {
    return null;
  }
}

export function saveEngineConfig(repoDir: string, cfg: PersistedEngineConfig): void {
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.writeFileSync(engineConfigPath(repoDir), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}
