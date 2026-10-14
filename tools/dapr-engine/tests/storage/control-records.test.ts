import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlRequestV1 } from "../../contract/v1/index.ts";
import { PostgresControlRecordStore } from "../../storage/index.ts";
import type { SqlQueryable } from "../../storage/postgres/operation-receipts.ts";

test("control requests reject oversized payloads before database access", async () => {
  const database: SqlQueryable = {
    async query() {
      throw new Error("Database must not be reached for an oversized control payload");
    },
  };
  const request: ControlRequestV1 = {
    schemaVersion: 1,
    controlId: "54c6ee71-6bdb-498e-9dd8-1e8ad67c234d",
    runId: "run-1",
    action: "pause",
    payload: { note: "x".repeat(64 * 1024) },
  };

  await assert.rejects(new PostgresControlRecordStore(database).request(request), RangeError);
});
