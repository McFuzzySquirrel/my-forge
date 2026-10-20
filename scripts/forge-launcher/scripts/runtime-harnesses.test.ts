import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HARNESS_CREDENTIAL_VARIABLES,
  ensureHarnessGrants,
  grantHarnessCredential,
  harnessGrantsDir,
  listHarnessGrants,
  revokeHarnessCredential,
} from "./runtime-harnesses.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function dataDir(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "forge-grants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the launcher allowlist matches the worker's", async () => {
  const engine = await import(path.resolve(here, "../../../tools/dapr-engine/service/harnesses.ts"));
  assert.deepEqual(HARNESS_CREDENTIAL_VARIABLES, engine.HARNESS_CREDENTIAL_VARIABLES);
});

test("grants live in a private directory and never list values", async (t) => {
  const root = await dataDir(t);
  const directory = await ensureHarnessGrants(root);
  assert.equal(directory, harnessGrantsDir(root));
  const file = path.join(directory, "grants.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1, grants: {} });
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }

  await grantHarnessCredential(root, "copilot", "GH_TOKEN", "secret-value\n");
  await grantHarnessCredential(root, "claude", "ANTHROPIC_API_KEY", "other");
  const listed = await listHarnessGrants(root);
  assert.deepEqual(listed, { copilot: ["GH_TOKEN"], claude: ["ANTHROPIC_API_KEY"], opencode: [] });
  assert.doesNotMatch(JSON.stringify(listed), /secret-value/);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).grants.copilot, { GH_TOKEN: "secret-value" });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

  assert.equal(await revokeHarnessCredential(root, "copilot", "GH_TOKEN"), true);
  assert.equal(await revokeHarnessCredential(root, "copilot", "GH_TOKEN"), false);
  assert.equal(await revokeHarnessCredential(root, "claude"), true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).grants, {});
});

test("grants reject unknown harnesses, foreign variables, and multi-line values", async (t) => {
  const root = await dataDir(t);
  await assert.rejects(grantHarnessCredential(root, "openai", "OPENAI_API_KEY", "x"), /Unknown harness/);
  await assert.rejects(grantHarnessCredential(root, "copilot", "ANTHROPIC_API_KEY", "x"), /accepts only/);
  await assert.rejects(grantHarnessCredential(root, "copilot", "PATH", "x"), /accepts only/);
  await assert.rejects(grantHarnessCredential(root, "copilot", "GH_TOKEN", "a\nb"), /single non-empty line/);
  await assert.rejects(grantHarnessCredential(root, "copilot", "GH_TOKEN", ""), /single non-empty line/);
});
