import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileActivityLogStore } from "../../service/activity.ts";
import { taskFileId } from "../../execution/task-execution.ts";

test("reads bounded per-attempt activity logs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = `run_${"a".repeat(32)}`;
  const directory = join(root, runId, taskFileId("FND-02"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "attempt-1.log"), "started\nworking\nfinished\n");

  const store = new FileActivityLogStore(root);
  const page = await store.read(runId, "FND-02", 1);
  assert.deepEqual(page, { lines: ["started", "working", "finished"], truncated: false });
  assert.equal(await store.read(runId, "FND-02", 2), undefined);
  await assert.rejects(store.read("../bad", "FND-02", 1), /Invalid run id/);
});
