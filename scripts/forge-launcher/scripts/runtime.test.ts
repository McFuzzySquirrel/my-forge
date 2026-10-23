import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  assertHostPortAvailable,
  databaseCredentialFingerprint,
  DEFAULT_RUNTIME_PROJECT,
  executeRuntimeAdminAction,
  ensureRuntimeCredentials,
  getRuntimeAdminState,
  getRuntimeDataDir,
  getRuntimeProject,
  parseRuntimeAdminAction,
  readRuntimeApiAccess,
  readRuntimeEnvironment,
  rotateRuntimeTokens,
  runtimeCli,
  unreadyServices,
  verifyRestoreSource,
} from "./runtime.ts";
import { registerRepository } from "./runtime-repositories.ts";

test("runtime credentials are generated once with restrictive permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const credentials = await ensureRuntimeCredentials(directory);
  const first = await readFile(credentials, "utf8");
  const fileStat = await lstat(credentials);
  const directoryStat = await lstat(directory);

  assert.match(first, /^POSTGRES_SUPERUSER_PASSWORD=[0-9a-f]{64}$/m);
  assert.match(first, /^DAPR_DB_PASSWORD=[0-9a-f]{64}$/m);
  assert.match(first, /^APP_DB_PASSWORD=[0-9a-f]{64}$/m);
  assert.match(first, /^MYFORGE_API_TOKEN=[0-9a-f]{64}$/m);
  assert.match(first, /^DAPR_API_TOKEN=[0-9a-f]{64}$/m);
  assert.equal(first.trim().split("\n").length, 5, "credentials must hold only secrets, not overridable settings");
  assert.doesNotMatch(first, /POSTGRES_PORT/);
  if (process.platform !== "win32") {
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.mode & 0o777, 0o700);
  }

  assert.equal(await ensureRuntimeCredentials(directory), credentials);
  assert.equal(await readFile(credentials, "utf8"), first);
});

test("runtime upgrades pre-API credentials with an API token without changing passwords", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = ["POSTGRES_SUPERUSER_PASSWORD", "DAPR_DB_PASSWORD", "APP_DB_PASSWORD"]
    .map((key, index) => `${key}=${String(index + 1).repeat(64)}`).join("\n") + "\n";
  const credentials = path.join(directory, "runtime.env");
  await writeFile(credentials, legacy, { mode: 0o600 });

  assert.equal(await ensureRuntimeCredentials(directory), credentials);
  const upgraded = await readFile(credentials, "utf8");
  assert.ok(upgraded.startsWith(legacy));
  assert.match(upgraded, /^MYFORGE_API_TOKEN=[0-9a-f]{64}$/m);
  assert.match(upgraded, /^DAPR_API_TOKEN=[0-9a-f]{64}$/m);
  if (process.platform !== "win32") assert.equal((await lstat(credentials)).mode & 0o777, 0o600);

  const access = await readRuntimeApiAccess(directory, { MYFORGE_API_PORT: "9000" });
  assert.equal(access.baseUrl, "http://127.0.0.1:9000");
  assert.equal(`MYFORGE_API_TOKEN=${access.token}`, upgraded.trim().split("\n")[3]);
  assert.equal((await readRuntimeApiAccess(directory, {})).baseUrl, "http://127.0.0.1:8483");
  await assert.rejects(readRuntimeApiAccess(directory, { MYFORGE_API_PORT: "0" }), /MYFORGE_API_PORT/);
});

test("runtime token rotation replaces only the API and sidecar tokens", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-rotate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = await ensureRuntimeCredentials(directory);
  const before = (await readFile(credentials, "utf8")).trim().split("\n");

  await rotateRuntimeTokens(directory);
  const after = (await readFile(credentials, "utf8")).trim().split("\n");
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), "database passwords must not change");
  assert.equal(after.length, 5);
  for (const index of [3, 4]) {
    assert.equal(after[index]!.split("=")[0], before[index]!.split("=")[0]);
    assert.notEqual(after[index], before[index]);
    assert.match(after[index]!, /^[A-Z_]+=[0-9a-f]{64}$/);
  }
  if (process.platform !== "win32") assert.equal((await lstat(credentials)).mode & 0o777, 0o600);
  await assert.rejects(rotateRuntimeTokens(path.join(directory, "missing")), /not initialized/);
});

test("runtime appends the Dapr API token to credentials created before it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-dapr-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const existing = ["POSTGRES_SUPERUSER_PASSWORD", "DAPR_DB_PASSWORD", "APP_DB_PASSWORD", "MYFORGE_API_TOKEN"]
    .map((key, index) => `${key}=${String(index + 1).repeat(64)}`).join("\n") + "\n";
  const credentials = path.join(directory, "runtime.env");
  await writeFile(credentials, existing, { mode: 0o600 });

  await ensureRuntimeCredentials(directory);
  const upgraded = await readFile(credentials, "utf8");
  assert.ok(upgraded.startsWith(existing));
  assert.match(upgraded.trim().split("\n")[4]!, /^DAPR_API_TOKEN=[0-9a-f]{64}$/);
});

test("runtime refuses to replace malformed existing credentials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "runtime.env");
  await writeFile(credentials, "POSTGRES_SUPERUSER_PASSWORD=bad\n", { mode: 0o600 });

  await assert.rejects(ensureRuntimeCredentials(directory), /refusing to replace them/);
  assert.equal(await readFile(credentials, "utf8"), "POSTGRES_SUPERUSER_PASSWORD=bad\n");
});

test("runtime rejects symlink credential files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.env");
  const credentials = path.join(directory, "runtime.env");
  await writeFile(target, "not credentials\n", { mode: 0o600 });
  await symlink(target, credentials);
  await assert.rejects(ensureRuntimeCredentials(directory), /regular file/);
});

test("runtime data directory follows platform conventions", () => {
  assert.equal(
    getRuntimeDataDir({}, "/home/operator", "linux"),
    "/home/operator/.local/share/MyForge/runtime",
  );
  assert.equal(
    getRuntimeDataDir({ XDG_DATA_HOME: "/data" }, "/home/operator", "linux"),
    "/data/MyForge/runtime",
  );
  assert.equal(
    getRuntimeDataDir({}, "/home/operator", "darwin"),
    "/home/operator/Library/Application Support/MyForge/runtime",
  );
  assert.equal(
    getRuntimeDataDir({ LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" }, "C:\\Users\\operator", "win32"),
    "C:\\Users\\operator\\AppData\\Local\\MyForge\\runtime",
  );
  assert.equal(
    getRuntimeDataDir({ MYFORGE_RUNTIME_DIR: "/tmp/qual/runtime/", XDG_DATA_HOME: "/data" }, "/home/operator", "linux"),
    "/tmp/qual/runtime/",
  );
  assert.throws(() => getRuntimeDataDir({ MYFORGE_RUNTIME_DIR: "relative/dir" }, "/home/operator", "linux"), /absolute path/);
});

test("runtime requires an explicit reset confirmation", async () => {
  await assert.rejects(runtimeCli(["reset"]), /rerun with --confirm/);
});

test("Console runtime actions validate confirmations and host-tool options", () => {
  assert.throws(() => parseRuntimeAdminAction({ action: "reset", confirmed: false }), /explicit confirmation/);
  assert.throws(() => parseRuntimeAdminAction({ action: "restore", from: "/tmp/backup", confirmed: true }), /allowGitDrift/);
  assert.throws(() => parseRuntimeAdminAction({ action: "start", hostTools: true, postgresPort: 65536 }), /1 to 65535/);
  assert.deepEqual(parseRuntimeAdminAction({ action: "stop", confirmed: true }), { action: "stop", confirmed: true });
  assert.throws(() => parseRuntimeAdminAction({
    action: "runner-capability",
    id: "demo",
    operation: "revoke",
    confirmed: false,
  }), /explicit confirmation/);
});

test("Console runtime capability controls never expose raw project credentials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "repositories.json"), JSON.stringify({
    version: 1,
    repositories: [{ id: "demo", path: directory }],
  }), { mode: 0o600 });

  const enabled = await executeRuntimeAdminAction({
    action: "runner-capability",
    id: "demo",
    operation: "enable",
    confirmed: true,
  }, directory);
  assert.equal(enabled.restartRequired, true);
  const state = await getRuntimeAdminState(directory);
  assert.deepEqual(state.hostRunnerEnabledRepositoryIds, ["demo"]);

  const rotated = await executeRuntimeAdminAction({
    action: "runner-capability",
    id: "demo",
    operation: "rotate",
    confirmed: true,
  }, directory);
  assert.match(rotated.message, /rotated/);
  assert.doesNotMatch(JSON.stringify(await getRuntimeAdminState(directory)), /[A-Za-z0-9_-]{43}/);

  await executeRuntimeAdminAction({
    action: "runner-capability",
    id: "demo",
    operation: "revoke",
    confirmed: true,
  }, directory);
  assert.deepEqual((await getRuntimeAdminState(directory)).hostRunnerEnabledRepositoryIds, []);
});

test("Console harness credential actions store secrets but expose only variable names", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-admin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "console-runtime-admin-secret";
  const grant = await executeRuntimeAdminAction({
    action: "harness-grant",
    harness: "copilot",
    variable: "GITHUB_TOKEN",
    value: secret,
  }, directory);
  assert.equal(grant.restartRequired, false);
  assert.doesNotMatch(grant.message, new RegExp(secret));

  const state = await getRuntimeAdminState(directory);
  assert.equal(state.initialized, false);
  assert.deepEqual(state.harnessGrants.copilot, ["GITHUB_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));

  const revoked = await executeRuntimeAdminAction({
    action: "harness-revoke",
    harness: "copilot",
    variable: "GITHUB_TOKEN",
    confirmed: true,
  }, directory);
  assert.match(revoked.message, /Revoked GITHUB_TOKEN/);
  assert.deepEqual((await getRuntimeAdminState(directory)).harnessGrants.copilot, []);
});

test("runtime backup and restore require explicit paths and restore confirmation", async () => {
  await assert.rejects(runtimeCli(["backup"]), /requires --output/);
  await assert.rejects(runtimeCli(["restore"]), /requires --from/);
  await assert.rejects(runtimeCli(["restore", "--from", "./backup"]), /rerun with --confirm/);
});

test("runtime rejects a host port unless host tools are enabled", async () => {
  await assert.rejects(runtimeCli(["start", "--postgres-port", "55433"]), /requires --host-tools/);
  await assert.rejects(runtimeCli(["start", "--host-tools", "--postgres-port", "65536"]), /1 to 65535/);
});

test("runtime reports an occupied loopback host port before starting Compose", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await assert.rejects(assertHostPortAvailable(address.port), /host port .* is unavailable/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("runtime readiness requires every service to be running", () => {
  const running = (service: string) => ({
    name: `myforge-runtime_${service}_1`,
    service,
    state: "running",
    ...(service === "forge" ? { health: "healthy" } : {}),
  });
  assert.deepEqual(unreadyServices(["postgres", "placement", "scheduler", "daprd", "forge"].map(running)), []);
  assert.deepEqual(
    unreadyServices([
      { ...running("postgres"), state: "created" },
      running("placement"),
      running("scheduler"),
      { ...running("forge"), health: "starting" },
    ]),
    ["postgres", "daprd", "forge"],
  );
});

test("runtime readiness waits for the Forge service health check", () => {
  const containers = ["postgres", "placement", "scheduler", "daprd"].map((service) => ({
    name: `myforge-runtime_${service}_1`,
    service,
    state: "running",
  }));
  assert.deepEqual(unreadyServices([...containers, {
    name: "myforge-runtime_forge_1",
    service: "forge",
    state: "running",
    health: "starting",
  }]), ["forge"]);
});

test("runtime rejects credential files carrying non-secret settings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-extra-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = await ensureRuntimeCredentials(directory);
  const original = await readFile(credentials, "utf8");
  await writeFile(credentials, `${original}POSTGRES_PORT=55432\n`, { mode: 0o600 });
  await assert.rejects(ensureRuntimeCredentials(directory), /refusing to replace them/);
});

test("runtime project defaults to myforge-runtime and accepts an isolated override", () => {
  assert.equal(getRuntimeProject({}), DEFAULT_RUNTIME_PROJECT);
  assert.equal(getRuntimeProject({ MYFORGE_RUNTIME_PROJECT: "" }), "myforge-runtime");
  assert.equal(getRuntimeProject({ MYFORGE_RUNTIME_PROJECT: "myforge-qual_1" }), "myforge-qual_1");
  for (const invalid of ["MyForge", "-x", "a b", "a/b", "x".repeat(64)]) {
    assert.throws(() => getRuntimeProject({ MYFORGE_RUNTIME_PROJECT: invalid }), /MYFORGE_RUNTIME_PROJECT/);
  }
});

test("restore verifies archive integrity, database credentials, and Git drift before touching volumes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-restore-"));
  const previousDir = process.env.MYFORGE_RUNTIME_DIR;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.MYFORGE_RUNTIME_DIR;
    else process.env.MYFORGE_RUNTIME_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });
  const runtimeDir = path.join(root, "runtime");
  process.env.MYFORGE_RUNTIME_DIR = runtimeDir;
  const environment = await readRuntimeEnvironment(path.dirname(await ensureRuntimeCredentials(runtimeDir)));

  const repository = path.join(root, "repo");
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "base");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "accepted");
  git("branch", "forge/main");
  const accepted = git("rev-parse", "forge/main");
  const base = git("rev-parse", "forge/main~1");

  const writeBackup = async (name: string, manifest: Record<string, unknown>) => {
    const directory = path.join(root, name);
    await mkdir(directory);
    const volumes = [];
    for (const volume of ["postgres_data", "scheduler_data", "runtime_data"]) {
      const contents = `${volume} archive`;
      await writeFile(path.join(directory, `${volume}.tar`), contents);
      volumes.push({ name: volume, file: `${volume}.tar`, sha256: createHash("sha256").update(contents).digest("hex") });
    }
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), volumes, ...manifest }));
    return directory;
  };
  const refs = { id: "repo", path: repository, refs: { "refs/heads/forge/main": accepted } };
  const consistent = await writeBackup("consistent", {
    databaseCredentialFingerprint: databaseCredentialFingerprint(environment.values),
    repositories: [refs],
  });

  // The backup's repository is not registered in this (fresh) installation.
  await assert.rejects(verifyRestoreSource(consistent, environment, false), /not registered in this installation/);
  await registerRepository(runtimeDir, repository, "repo");
  assert.equal((await verifyRestoreSource(consistent, environment, false)).repositories?.length, 1);

  // Restored PostgreSQL data keeps the credentials it was initialized with.
  const otherCredentials = await writeBackup("other-credentials", {
    databaseCredentialFingerprint: "0".repeat(64),
    repositories: [refs],
  });
  await assert.rejects(verifyRestoreSource(otherCredentials, environment, false), /different database credentials.*Copy runtime\.env/s);

  // Git moved since the backup: refused unless the operator accepts the drift.
  git("update-ref", "refs/heads/forge/main", base);
  await assert.rejects(verifyRestoreSource(consistent, environment, false),
    new RegExp(`Git no longer matches the backup[\\s\\S]*update-ref refs/heads/forge/main ${accepted}`));
  assert.ok(await verifyRestoreSource(consistent, environment, true));
  git("update-ref", "refs/heads/forge/main", accepted);

  // Older backups without recorded refs or fingerprint are still accepted.
  assert.ok(await verifyRestoreSource(await writeBackup("legacy", {}), environment, false));

  // A tampered volume archive or manifest is rejected.
  await writeFile(path.join(consistent, "runtime_data.tar"), "tampered");
  await assert.rejects(verifyRestoreSource(consistent, environment, false), /runtime_data' is missing or failed its integrity check/);
  await rm(path.join(consistent, "scheduler_data.tar"));
  await assert.rejects(verifyRestoreSource(consistent, environment, false), /volume 'scheduler_data' is missing/);
  await rm(path.join(consistent, "manifest.json"));
  await assert.rejects(verifyRestoreSource(consistent, environment, false), /Backup manifest is missing/);
  const forged = await writeBackup("forged", { repositories: [{ ...refs, refs: { "refs/heads/main": accepted } }] });
  await assert.rejects(verifyRestoreSource(forged, environment, false), /invalid repository record/);
});
