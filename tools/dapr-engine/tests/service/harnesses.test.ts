import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultServiceHarnesses,
  parseHarnessGrants,
  readHarnessGrants,
  resolveExecutable,
} from "../../service/harnesses.ts";
import { ServiceRunRegistry } from "../../service/runs.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "forge-harnesses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const copilot = join(bin, "copilot");
  await writeFile(copilot, "#!/bin/sh\nexit 0\n");
  await chmod(copilot, 0o755);
  return { root, bin, grants: join(root, "grants.json") };
}

test("grant parsing keeps only allowlisted variables for each harness", () => {
  const grants = parseHarnessGrants(JSON.stringify({
    schemaVersion: 1,
    grants: {
      copilot: { GH_TOKEN: "gh", ANTHROPIC_API_KEY: "wrong-harness", PATH: "/evil", COPILOT_GITHUB_TOKEN: "" },
      claude: { ANTHROPIC_API_KEY: "anthropic" },
      unknown: { GH_TOKEN: "x" },
    },
  }));
  assert.deepEqual(grants.grants, { copilot: { GH_TOKEN: "gh" }, claude: { ANTHROPIC_API_KEY: "anthropic" } });
  assert.throws(() => parseHarnessGrants(JSON.stringify({ schemaVersion: 2, grants: {} })), /schemaVersion 1/);
  assert.deepEqual(readHarnessGrants(join(tmpdir(), "missing-forge-grants.json")).grants, {});
});

test("CLI harnesses require an installed binary and a credential grant", async (t) => {
  const { bin, grants } = await fixture(t);
  const harnesses = defaultServiceHarnesses({ credentialsFile: grants, environment: { PATH: bin } });
  const registry = new ServiceRunRegistry(harnesses);
  assert.equal(registry.harnessUnavailable({ id: "stub", adapterVersion: "1" }), undefined);
  assert.match(registry.harnessUnavailable({ id: "claude", adapterVersion: "1" })!, /not installed/);
  assert.match(registry.harnessUnavailable({ id: "copilot", adapterVersion: "1" })!, /runtime harness grant copilot/);
  assert.match(registry.harnessUnavailable({ id: "copilot", adapterVersion: "2" })!, /copilot@2/);
  assert.match(registry.harnessUnavailable({ id: "nope", adapterVersion: "1" })!, /not available/);

  await writeFile(grants, JSON.stringify({ schemaVersion: 1, grants: { copilot: { GH_TOKEN: "first" } } }));
  assert.equal(registry.harnessAvailable({ id: "copilot", adapterVersion: "1" }), true);
  const credentials = harnesses.get("copilot")!.credentials!;
  assert.deepEqual(await credentials(), { GH_TOKEN: "first" });
  // Grants are re-read per attempt, so a revocation applies without a restart.
  await writeFile(grants, JSON.stringify({ schemaVersion: 1, grants: {} }));
  assert.deepEqual(await credentials(), {});
});

test("claude runs as a sandboxed root process only inside a root worker", async (t) => {
  const { grants } = await fixture(t);
  await writeFile(grants, JSON.stringify({ schemaVersion: 1, grants: { claude: { ANTHROPIC_API_KEY: "key" } } }));
  const asRoot = defaultServiceHarnesses({ credentialsFile: grants, root: true });
  const asUser = defaultServiceHarnesses({ credentialsFile: grants, root: false });
  assert.deepEqual(await asRoot.get("claude")!.credentials!(), { IS_SANDBOX: "1", ANTHROPIC_API_KEY: "key" });
  assert.deepEqual(await asUser.get("claude")!.credentials!(), { ANTHROPIC_API_KEY: "key" });
  assert.deepEqual(await asRoot.get("copilot")!.credentials!(), {});
});

test("executables resolve from PATH or an absolute override", async (t) => {
  const { bin } = await fixture(t);
  assert.equal(resolveExecutable("copilot", bin), join(bin, "copilot"));
  assert.equal(resolveExecutable(join(bin, "copilot"), ""), join(bin, "copilot"));
  assert.equal(resolveExecutable("claude", bin), undefined);
  assert.equal(resolveExecutable("bin", bin.replace(/\/bin$/, "")), undefined);
});
