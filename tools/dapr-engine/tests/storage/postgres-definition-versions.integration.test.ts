import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  assertActiveRunDefinitionsSupported,
  ORCHESTRATION_DEFINITION_VERSION,
} from "../../orchestration/versioning.ts";
import { migrateApplicationDatabase } from "../../service/migrations.ts";
import { PostgresRunStatusStore } from "../../storage/postgres/run-status.ts";

const connectionString = process.env.POSTGRES_TEST_URL;
const digest = `sha256:${"a".repeat(64)}`;

test("runs record their orchestration definition and startup refuses unsupported active runs", {
  skip: !connectionString,
}, async () => {
  const schema = `p6_definitions_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let database: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrateApplicationDatabase(database);
    const store = new PostgresRunStatusStore(database);
    for (const fill of ["1", "2"]) {
      await store.createRun({
        schemaVersion: 1, runId: `run_${fill.repeat(32)}`, repositoryId: "demo",
        targetRef: "refs/heads/forge/demo", manifestDigest: digest, taskIds: ["T1"],
      } as never);
    }
    const rows = await database.query("SELECT definition_version FROM forge_run_statuses ORDER BY run_id");
    assert.deepEqual(rows.rows.map((row) => row.definition_version), [ORCHESTRATION_DEFINITION_VERSION, ORCHESTRATION_DEFINITION_VERSION]);

    await assertActiveRunDefinitionsSupported(database);
    await assert.rejects(assertActiveRunDefinitionsSupported(database, [2]), /2 run\(s\) at definition v1; supported: v2/);

    await database.query("UPDATE forge_run_statuses SET status = 'complete'");
    await assertActiveRunDefinitionsSupported(database, [2]);
  } finally {
    await database?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
