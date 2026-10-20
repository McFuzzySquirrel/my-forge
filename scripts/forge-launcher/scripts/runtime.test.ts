import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertHostPortAvailable, ensureRuntimeCredentials, getRuntimeDataDir, runtimeCli, unreadyServices } from "./runtime.ts";

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
  assert.equal(first.trim().split("\n").length, 3, "credentials must hold only secrets, not overridable settings");
  assert.doesNotMatch(first, /POSTGRES_PORT/);
  if (process.platform !== "win32") {
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.mode & 0o777, 0o700);
  }

  assert.equal(await ensureRuntimeCredentials(directory), credentials);
  assert.equal(await readFile(credentials, "utf8"), first);
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
});

test("runtime requires an explicit reset confirmation", async () => {
  await assert.rejects(runtimeCli(["reset"]), /rerun with --confirm/);
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
  const running = (service: string) => ({ name: `myforge-runtime_${service}_1`, service, state: "running" });
  assert.deepEqual(unreadyServices(["postgres", "placement", "scheduler", "daprd"].map(running)), []);
  assert.deepEqual(
    unreadyServices([
      { ...running("postgres"), state: "created" },
      running("placement"),
      running("scheduler"),
    ]),
    ["postgres", "daprd"],
  );
});

test("runtime rejects credential files carrying non-secret settings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-extra-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = await ensureRuntimeCredentials(directory);
  const original = await readFile(credentials, "utf8");
  await writeFile(credentials, `${original}POSTGRES_PORT=55432\n`, { mode: 0o600 });
  await assert.rejects(ensureRuntimeCredentials(directory), /refusing to replace them/);
});
