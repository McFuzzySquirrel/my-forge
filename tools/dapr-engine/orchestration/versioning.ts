/**
 * Orchestration definition versioning (ADR-074).
 *
 * The current version is stamped on every new run. Changes that keep recorded
 * histories replayable (proved by tests/orchestration/history-replay.test.ts)
 * keep the version. An incompatible change must register its workflows under
 * new names, bump this version, and keep the previous definitions registered
 * (and their version in SUPPORTED) until runs that use them have drained.
 */
export const ORCHESTRATION_DEFINITION_VERSION = 1;
export const SUPPORTED_ORCHESTRATION_DEFINITION_VERSIONS: readonly number[] = [1];

const TERMINAL_RUN_STATUSES = ["complete", "failed", "cancelled"] as const;

export interface DefinitionVersionQueryable {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** Refuses startup when non-terminal runs were started by a definition this build cannot replay. */
export async function assertActiveRunDefinitionsSupported(
  database: DefinitionVersionQueryable,
  supported: readonly number[] = SUPPORTED_ORCHESTRATION_DEFINITION_VERSIONS,
): Promise<void> {
  const result = await database.query<{ definition_version: number; runs: string | number }>(
    `SELECT definition_version, COUNT(*) AS runs FROM forge_run_statuses
     WHERE status <> ALL($1::text[]) GROUP BY definition_version ORDER BY definition_version`,
    [TERMINAL_RUN_STATUSES],
  );
  const unsupported = result.rows.filter((row) => !supported.includes(Number(row.definition_version)));
  if (unsupported.length === 0) return;
  const detail = unsupported.map((row) => `${row.runs} run(s) at definition v${row.definition_version}`).join(", ");
  throw new Error(
    `Active runs use orchestration definitions this engine cannot replay (${detail}; supported: `
      + `${supported.map((version) => `v${version}`).join(", ")}). Finish or cancel them with the release that `
      + "started them, or roll back to it, before upgrading.",
  );
}
