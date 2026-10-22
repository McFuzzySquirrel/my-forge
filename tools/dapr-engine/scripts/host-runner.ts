import { lstat, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HostRunnerHttpClient } from "../execution/host-runner-client.ts";
import { HostRunnerWorker } from "../execution/host-runner-worker.ts";
import { NativeHarnessRunner } from "../execution/native-harness-runner.ts";
import { defaultServiceHarnesses } from "../service/harnesses.ts";
import type { HostRunnerCredentialV1 } from "../execution/host-runner-worker.ts";

const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

interface RepositoryRegistryV1 {
  readonly version: 1;
  readonly repositories: readonly { readonly id: string; readonly path: string }[];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readPrivateJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Host-runner configuration must be regular files.");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error("Host-runner capability file must be owner-only.");
  }
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function parseRepositoryRegistry(value: unknown): RepositoryRegistryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host-runner repository registry has an invalid schema.");
  }
  const registry = value as Partial<RepositoryRegistryV1>;
  if (registry.version !== 1 || !Array.isArray(registry.repositories)
    || !registry.repositories.every((entry) => entry
      && typeof entry.id === "string" && REPOSITORY_ID.test(entry.id)
      && typeof entry.path === "string" && isAbsolute(entry.path))) {
    throw new TypeError("Host-runner repository registry has an invalid schema.");
  }
  return registry as RepositoryRegistryV1;
}

function parseCapabilities(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host-runner capability file has an invalid schema.");
  }
  const parsed = value as { version?: unknown; capabilities?: unknown };
  if (parsed.version !== 1 || !parsed.capabilities || typeof parsed.capabilities !== "object"
    || Array.isArray(parsed.capabilities)) {
    throw new TypeError("Host-runner capability file has an invalid schema.");
  }
  const capabilities: Record<string, string> = {};
  for (const [repositoryId, capability] of Object.entries(parsed.capabilities)) {
    if (!REPOSITORY_ID.test(repositoryId) || typeof capability !== "string" || !CAPABILITY.test(capability)) {
      throw new TypeError("Host-runner capability file contains an invalid entry.");
    }
    capabilities[repositoryId] = capability;
  }
  return capabilities;
}

async function loadRepositories(): Promise<{
  readonly roots: ReadonlyMap<string, string>;
  readonly credentials: readonly HostRunnerCredentialV1[];
}> {
  const registryPath = requiredEnvironment("MYFORGE_HOST_RUNNER_REPOSITORIES_FILE");
  const capabilitiesPath = requiredEnvironment("MYFORGE_HOST_RUNNER_CAPABILITIES_FILE");
  const [registryValue, capabilitiesValue] = await Promise.all([
    readPrivateJson(registryPath),
    readPrivateJson(capabilitiesPath),
  ]);
  const registry = parseRepositoryRegistry(registryValue);
  const capabilities = parseCapabilities(capabilitiesValue);
  const roots = new Map<string, string>();
  for (const repository of registry.repositories) {
    const capability = capabilities[repository.id];
    if (!capability) continue;
    const root = await realpath(repository.path);
    if (!(await stat(root)).isDirectory()) throw new Error("A registered host repository is not a directory.");
    roots.set(repository.id, root);
  }
  const credentials = [...roots.keys()].map((repositoryId) => ({
    repositoryId,
    capability: capabilities[repositoryId]!,
  }));
  return { roots, credentials };
}

async function main(): Promise<void> {
  const baseUrl = requiredEnvironment("MYFORGE_HOST_RUNNER_BASE_URL");
  const apiToken = requiredEnvironment("MYFORGE_HOST_RUNNER_API_TOKEN");
  const workspacesRoot = requiredEnvironment("MYFORGE_HOST_RUNNER_WORKSPACES_DIR");
  const { roots, credentials } = await loadRepositories();
  if (credentials.length === 0) return;

  const client = new HostRunnerHttpClient({ baseUrl, apiToken });
  const readyDeadline = Date.now() + 30_000;
  let serviceReady = false;
  let lastReadinessError: unknown;
  while (!serviceReady && Date.now() < readyDeadline) {
    try {
      serviceReady = await client.ready();
    } catch (error) {
      // The launcher starts the host runner immediately after the service health check.
      lastReadinessError = error;
    }
    if (!serviceReady) await delay(500);
  }
  if (!serviceReady) {
    throw new Error("Execution service did not become ready for host-runner polling.", { cause: lastReadinessError });
  }

  const readyFile = requiredEnvironment("MYFORGE_HOST_RUNNER_READY_FILE");
  const instanceId = requiredEnvironment("MYFORGE_HOST_RUNNER_INSTANCE_ID");
  await writeFile(readyFile, instanceId, { flag: "wx", mode: 0o600 });
  const serviceHarnesses = defaultServiceHarnesses({ environment: process.env, root: false });
  const harnesses = new Map([...serviceHarnesses].map(([name, serviceHarness]) => [name, serviceHarness.create()]));
  const runner = new NativeHarnessRunner({
    workspacesRoot,
    repositoryRoot: (repositoryId) => roots.get(repositoryId),
    harnesses,
  });
  const worker = new HostRunnerWorker({
    client,
    runner,
    repositories: credentials,
    onError: () => process.stderr.write("Host runner could not poll or dispatch a job; it will retry.\n"),
  });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await worker.run(shutdown.signal);
  } finally {
    await unlink(readyFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`Host runner failed to start: ${message}\n`);
  process.exitCode = 1;
});
