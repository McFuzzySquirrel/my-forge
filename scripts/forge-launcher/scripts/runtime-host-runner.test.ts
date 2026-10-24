import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ensureHostRunnerFiles,
  getHostRunnerProcessStatus,
  startHostRunner,
  stopHostRunner,
  updateHostRunnerCapability,
} from "./runtime-host-runner.ts";
import { currentVersion } from "./update-check.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("host-runner capabilities are stable, scoped to registered repositories, and hash-separated", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-host-runner-"));
  roots.push(dataDir);
  await writeFile(path.join(dataDir, "repositories.json"), JSON.stringify({
    version: 1,
    repositories: [{ id: "demo", path: path.join(dataDir, "repo") }],
  }), { mode: 0o600 });

  const files = await ensureHostRunnerFiles(dataDir);
  assert.equal(await getHostRunnerProcessStatus(dataDir), "stopped");
  const raw = JSON.parse(await readFile(files.capabilitiesFile, "utf8")) as {
    capabilities: Record<string, string>;
  };
  const hashes = JSON.parse(await readFile(files.hashesFile, "utf8")) as {
    capabilities: Record<string, string>;
  };
  assert.deepEqual(Object.keys(raw.capabilities), ["demo"]);
  assert.match(raw.capabilities.demo!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    hashes.capabilities.demo,
    `sha256:${createHash("sha256").update(raw.capabilities.demo!).digest("hex")}`,
  );
  assert.ok(!JSON.stringify(hashes).includes(raw.capabilities.demo!));
  assert.deepEqual((await ensureHostRunnerFiles(dataDir)).repositories, { demo: path.join(dataDir, "repo") });
  assert.equal(
    JSON.parse(await readFile(files.capabilitiesFile, "utf8")).capabilities.demo,
    raw.capabilities.demo,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(files.capabilitiesFile)).mode & 0o077, 0);
    assert.equal((await stat(files.hashesFile)).mode & 0o077, 0);
  }

  await writeFile(path.join(dataDir, "repositories.json"), JSON.stringify({ version: 1, repositories: [] }), { mode: 0o600 });
  await ensureHostRunnerFiles(dataDir);
  assert.deepEqual(JSON.parse(await readFile(files.capabilitiesFile, "utf8")).capabilities, {});
  assert.deepEqual(JSON.parse(await readFile(files.hashesFile, "utf8")).capabilities, {});
});

test("host-runner capabilities can be enabled, rotated, and revoked without accidental reissue", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-host-runner-"));
  roots.push(dataDir);
  await writeFile(path.join(dataDir, "repositories.json"), JSON.stringify({
    version: 1,
    repositories: [{ id: "demo", path: path.join(dataDir, "repo") }],
  }), { mode: 0o600 });

  await ensureHostRunnerFiles(dataDir);
  const capabilitiesFile = path.join(dataDir, "host-runner-capabilities.json");
  const first = JSON.parse(await readFile(capabilitiesFile, "utf8")).capabilities.demo as string;
  await updateHostRunnerCapability(dataDir, "demo", "rotate");
  const rotated = JSON.parse(await readFile(capabilitiesFile, "utf8")).capabilities.demo as string;
  assert.notEqual(rotated, first);

  await updateHostRunnerCapability(dataDir, "demo", "revoke");
  assert.deepEqual(JSON.parse(await readFile(capabilitiesFile, "utf8")).capabilities, {});
  assert.deepEqual((await ensureHostRunnerFiles(dataDir)).enabledRepositoryIds, []);
  assert.equal(await getHostRunnerProcessStatus(dataDir), "disabled");
  await assert.rejects(updateHostRunnerCapability(dataDir, "demo", "rotate"), /revoked/);

  await updateHostRunnerCapability(dataDir, "demo", "enable");
  const enabled = JSON.parse(await readFile(capabilitiesFile, "utf8")).capabilities.demo as string;
  assert.match(enabled, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(enabled, rotated);
});

test("host-runner configuration fails closed when raw capabilities are not private", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-host-runner-"));
  roots.push(dataDir);
  await writeFile(path.join(dataDir, "repositories.json"), JSON.stringify({
    version: 1,
    repositories: [{ id: "demo", path: path.join(dataDir, "repo") }],
  }), { mode: 0o600 });
  const files = await ensureHostRunnerFiles(dataDir);
  if (process.platform !== "win32") await chmod(files.capabilitiesFile, 0o644);
  if (process.platform !== "win32") {
    await assert.rejects(ensureHostRunnerFiles(dataDir), /owner-only/);
  }
  await stopHostRunner(dataDir);
});

test("host-runner startup waits for service readiness and stops cleanly", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-host-runner-"));
  roots.push(dataDir);
  const repositoryPath = path.join(dataDir, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(dataDir, "repositories.json"), JSON.stringify({
    version: 1,
    repositories: [{ id: "demo", path: repositoryPath }],
  }), { mode: 0o600 });
  await ensureHostRunnerFiles(dataDir);

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health/ready" ? { ready: true } : { claim: null }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const testFile = fileURLToPath(import.meta.url);
  const packageDir = path.resolve(path.dirname(testFile), "..");
  const engineDir = path.resolve(path.dirname(testFile), "../../../tools/dapr-engine");
  const apiToken = "runtime-api-token-long-enough-for-test";

  try {
    await startHostRunner(dataDir, apiToken, address.port, engineDir, packageDir);
    assert.equal(await getHostRunnerProcessStatus(dataDir), "running");
    const pidFile = path.join(dataDir, "host-runner.pid");
    const started = JSON.parse(await readFile(pidFile, "utf8")) as {
      instanceId: string;
      launcherVersion?: string;
    };
    assert.equal(started.launcherVersion, currentVersion());
    // A live runner from an older launcher must be replaced, not reused.
    await writeFile(pidFile, `${JSON.stringify({ ...started, launcherVersion: "0.0.0-stale" })}\n`, { mode: 0o600 });
    await startHostRunner(dataDir, apiToken, address.port, engineDir, packageDir);
    const restarted = JSON.parse(await readFile(pidFile, "utf8")) as {
      instanceId: string;
      launcherVersion?: string;
    };
    assert.notEqual(restarted.instanceId, started.instanceId);
    assert.equal(restarted.launcherVersion, currentVersion());
    assert.equal(await getHostRunnerProcessStatus(dataDir), "running");
    await stopHostRunner(dataDir);
    assert.equal(await getHostRunnerProcessStatus(dataDir), "stopped");
    assert.ok(!(await readFile(path.join(dataDir, "host-runner.log"), "utf8")).includes(apiToken));
  } finally {
    await stopHostRunner(dataDir);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
