import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TransactionalSqlConnection, TransactionalSqlDatabase } from "../storage/postgres/repository-integration.ts";

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

interface AppliedMigration extends Record<string, unknown> {
  version: number;
  name: string;
  checksum: string;
}

const ADVISORY_LOCK = 1_947_260_381;
const MIGRATION_FILES = [
  "repository-integration.sql",
  "operation-receipts.sql",
  "operation-executions.sql",
  "control-records.sql",
  "run-status.sql",
] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function loadMigrations(): Promise<DatabaseMigration[]> {
  return Promise.all(MIGRATION_FILES.map(async (name, index) => ({
    version: index + 1,
    name,
    sql: await readFile(new URL(`../storage/postgres/${name}`, import.meta.url), "utf8"),
  })));
}

function validateMigrationList(migrations: readonly DatabaseMigration[]): void {
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1
      || !migration.name || !migration.sql.trim()
      || versions.has(migration.version) || names.has(migration.name)) {
      throw new Error("Database migrations must have unique positive versions, names, and non-empty SQL");
    }
    versions.add(migration.version);
    names.add(migration.name);
  }
  const sorted = [...versions].sort((left, right) => left - right);
  if (sorted.some((version, index) => version !== index + 1)) {
    throw new Error("Database migration versions must be contiguous and start at 1");
  }
}

async function lockMigrations(connection: TransactionalSqlConnection): Promise<void> {
  await connection.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK]);
}

async function unlockMigrations(connection: TransactionalSqlConnection): Promise<void> {
  await connection.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]);
}

async function applyMigration(
  connection: TransactionalSqlConnection,
  migration: DatabaseMigration,
): Promise<void> {
  await connection.query("BEGIN");
  try {
    await connection.query(migration.sql);
    await connection.query(
      `INSERT INTO forge_schema_migrations (version, name, checksum, applied_at)
       VALUES ($1, $2, $3, NOW())`,
      [migration.version, migration.name, checksum(migration.sql)],
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}

export async function applyDatabaseMigrations(
  database: TransactionalSqlDatabase,
  migrations: readonly DatabaseMigration[],
): Promise<void> {
  validateMigrationList(migrations);
  const connection = await database.connect();
  let locked = false;
  try {
    await lockMigrations(connection);
    locked = true;
    await connection.query(`
      CREATE TABLE IF NOT EXISTS forge_schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL
      )
    `);
    const rows = await connection.query<AppliedMigration>(
      "SELECT version, name, checksum FROM forge_schema_migrations ORDER BY version",
    );
    const applied = new Map(rows.rows.map((row) => [row.version, row]));
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      const currentChecksum = checksum(migration.sql);
      if (previous) {
        if (previous.name !== migration.name || previous.checksum !== currentChecksum) {
          throw new Error(`Applied database migration ${migration.version} (${migration.name}) no longer matches its recorded checksum`);
        }
        continue;
      }
      if (applied.size !== migration.version - 1) {
        throw new Error(`Database migration history has a gap before version ${migration.version}`);
      }
      await applyMigration(connection, migration);
      applied.set(migration.version, {
        version: migration.version,
        name: migration.name,
        checksum: currentChecksum,
      });
    }
    const newestKnown = migrations.at(-1)?.version ?? 0;
    const newestApplied = rows.rows.at(-1)?.version ?? 0;
    if (newestApplied > newestKnown) {
      throw new Error(`Database schema version ${newestApplied} is newer than this Forge service supports (${newestKnown})`);
    }
  } finally {
    try {
      if (locked) await unlockMigrations(connection);
    } finally {
      connection.release();
    }
  }
}

export async function migrateApplicationDatabase(database: TransactionalSqlDatabase): Promise<void> {
  await applyDatabaseMigrations(database, await loadMigrations());
}
