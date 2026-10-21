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

test("owned task processes drop UID, GID, supplementary groups, and capabilities", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0,
}, async () => {
  const result = await runCommand(process.execPath, ["-e", `
    const status = require("node:fs").readFileSync("/proc/self/status", "utf8");
    const fields = Object.fromEntries([...status.matchAll(/^((?:Cap(?:Inh|Prm|Eff|Bnd|Amb))|NoNewPrivs):\\s+(\\S+)$/gm)]
      .map(([, key, value]) => [key, value]));
    console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), fields }));
  `], {
    cwd: "/tmp",
    timeoutMs: 5_000,
    maxBufferBytes: 4096,
    processIdentity: { uid: 65_534, gid: 65_534 },
    reapProcessGroupOnExit: true,
  });

  assert.equal(result.status, 0, result.error ?? result.stderr);
  const execution = JSON.parse(result.stdout) as {
    uid: number;
    gid: number;
    groups: number[];
    fields: Record<string, string>;
  };
  assert.equal(execution.uid, 65_534);
  assert.equal(execution.gid, 65_534);
  assert.ok(execution.groups.every((group) => group === execution.gid));
  for (const capability of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    assert.match(execution.fields[capability]!, /^0+$/);
  }
  assert.equal(execution.fields.NoNewPrivs, "1");
});
