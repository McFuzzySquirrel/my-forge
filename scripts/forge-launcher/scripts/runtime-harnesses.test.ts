import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HARNESS_CREDENTIAL_VARIABLES,
  ensureHarnessGrants,
  grantHarnessCredential,
  harnessGrantsDir,
  listHarnessGrants,
  revokeHarnessCredential,
  validateOpenCodeAuthGrant,
} from "./runtime-harnesses.ts";

async function dataDir(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "forge-grants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the launcher allowlist matches the worker's", async () => {
  const engine = await import(new URL("../../../tools/dapr-engine/service/harness-credentials.ts", import.meta.url).href);
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

test("an existing grants file is repaired to owner-only", async (t) => {
  const root = await dataDir(t);
  const directory = harnessGrantsDir(root);
  const file = path.join(directory, "grants.json");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, grants: {} }));
  await chmod(directory, 0o755);
  await chmod(file, 0o644);

  await ensureHarnessGrants(root);

  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("a symlinked grants file is rejected", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await dataDir(t);
  const directory = harnessGrantsDir(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(root, "elsewhere.json");
  await writeFile(target, JSON.stringify({ schemaVersion: 1, grants: {} }));
  await symlink(target, path.join(directory, "grants.json"));

  await assert.rejects(ensureHarnessGrants(root), /regular file/);
});

test("OpenCode auth grants require exactly one provider entry", async (t) => {
  assert.doesNotThrow(() => validateOpenCodeAuthGrant(JSON.stringify([
    { integrationID: "deepseek", value: { type: "api", key: "secret" } },
  ])));
  for (const invalid of [
    "not json",
    "[]",
    JSON.stringify([{ integrationID: "deepseek" }, { integrationID: "github-copilot" }]),
    JSON.stringify([{ value: {} }]),
  ]) {
    assert.throws(() => validateOpenCodeAuthGrant(invalid));
  }

  const root = await dataDir(t);
  await assert.rejects(
    grantHarnessCredential(root, "opencode", "OPENCODE_AUTH_JSON", "[]"),
    /exactly one exported provider credential/,
  );
  await assert.rejects(
    grantHarnessCredential(root, "opencode", "OPENCODE_AUTH_JSON", JSON.stringify([
      { integrationID: "deepseek" },
      { integrationID: "github-copilot" },
    ])),
    /exactly one exported provider credential/,
  );
});
