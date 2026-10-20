import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  SqlQueryable,
  SqlQueryResult,
} from "../../storage/postgres/operation-receipts.ts";
import type {
  TransactionalSqlConnection,
  TransactionalSqlDatabase,
} from "../../storage/postgres/repository-integration.ts";
import { applyDatabaseMigrations, type DatabaseMigration } from "../../service/migrations.ts";

interface StoredMigration extends Record<string, unknown> {
  version: number;
  name: string;
  checksum: string;
}

class MemoryDatabase implements TransactionalSqlDatabase, SqlQueryable {
  readonly applied: StoredMigration[] = [];
  readonly executed: string[] = [];
  released = false;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const query = text.trim();
    if (query.startsWith("SELECT version, name, checksum FROM forge_schema_migrations")) {
      return { rows: [...this.applied] as unknown as Row[] };
    }
    if (query.startsWith("INSERT INTO forge_schema_migrations")) {
      this.applied.push({
        version: values[0] as number,
        name: values[1] as string,
        checksum: values[2] as string,
      });
      return { rows: [] };
    }
    if (!query.startsWith("SELECT pg_advisory_")) this.executed.push(query);
    return { rows: [] };
  }

  async connect(): Promise<TransactionalSqlConnection> {
    return {
      query: (text, values) => this.query(text, values),
      release: () => { this.released = true; },
    };
  }
}

function migration(version: number, sql: string): DatabaseMigration {
  return { version, name: `migration-${version}.sql`, sql };
}

test("application migrations apply once and verify immutable checksums", async () => {
  const database = new MemoryDatabase();
  const migrations = [migration(1, "SELECT 'first'"), migration(2, "SELECT 'second'")];

  await applyDatabaseMigrations(database, migrations);
  database.released = false;
  await applyDatabaseMigrations(database, migrations);

  assert.equal(database.applied.length, 2);
  assert.equal(database.executed.filter((query) => query.startsWith("SELECT '")).length, 2);
  assert.equal(database.released, true);
  assert.equal(
    database.applied[0]?.checksum,
    createHash("sha256").update("SELECT 'first'").digest("hex"),
  );
});

test("application migrations reject edits to already applied SQL", async () => {
  const database = new MemoryDatabase();
  await applyDatabaseMigrations(database, [migration(1, "SELECT 'first'")]);

  await assert.rejects(
    applyDatabaseMigrations(database, [migration(1, "SELECT 'edited'")]),
    /no longer matches its recorded checksum/,
  );
  assert.equal(database.released, true);
});

test("application migrations reject gaps and newer schema versions", async () => {
  const gap = new MemoryDatabase();
  gap.applied.push({ version: 2, name: "migration-2.sql", checksum: "0".repeat(64) });
  await assert.rejects(
    applyDatabaseMigrations(gap, [migration(1, "SELECT 1"), migration(2, "SELECT 2")]),
    /history has a gap/,
  );

  const newer = new MemoryDatabase();
  newer.applied.push(
    { version: 1, name: "migration-1.sql", checksum: createHash("sha256").update("SELECT 1").digest("hex") },
    { version: 2, name: "migration-2.sql", checksum: createHash("sha256").update("SELECT 2").digest("hex") },
  );
  await assert.rejects(
    applyDatabaseMigrations(newer, [migration(1, "SELECT 1")]),
    /newer than this Forge service supports/,
  );
});

test("application migrations require contiguous version numbers", async () => {
  const database = new MemoryDatabase();
  await assert.rejects(
    applyDatabaseMigrations(database, [migration(1, "SELECT 1"), migration(3, "SELECT 3")]),
    /contiguous and start at 1/,
  );
  assert.equal(database.released, false);
});
