import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateTaskProcessIdentity, releaseTaskProcessIdentity } from "../../execution/isolation.ts";
import { runCommand } from "../../execution/harness/run.ts";

test("task process identities are unique among live attempts", () => {
  const first = allocateTaskProcessIdentity();
  const second = allocateTaskProcessIdentity();
  releaseTaskProcessIdentity(first);
  const third = allocateTaskProcessIdentity();

  assert.notEqual(first.uid, second.uid);
  assert.notEqual(first.uid, third.uid);
  assert.notEqual(second.uid, third.uid);
  assert.equal(first.gid, first.uid);
  releaseTaskProcessIdentity(second);
  releaseTaskProcessIdentity(third);
});

test("owned task processes drop UID, GID, and supplementary groups", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0,
}, async () => {
  const result = await runCommand("id", ["-u"], {
    cwd: "/tmp",
    timeoutMs: 5_000,
    maxBufferBytes: 1024,
    processIdentity: { uid: 65_534, gid: 65_534 },
    reapProcessGroupOnExit: true,
  });

  assert.equal(result.status, 0, result.error ?? result.stderr);
  assert.equal(result.stdout.trim(), "65534");
});
