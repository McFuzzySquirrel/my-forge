/**
 * Shared live-verification stack: an ephemeral rootless Podman pod with Dapr
 * 1.18.7 (daprd, placement, scheduler) and its PostgreSQL state store. Only
 * daprd gRPC/HTTP are published, on 127.0.0.1. Images must already be pulled.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const IMAGES = {
  daprd: "docker.io/daprio/daprd:1.18.7",
  placement: "docker.io/daprio/placement:1.18.7",
  scheduler: "docker.io/daprio/scheduler:1.18.7",
  postgres: "docker.io/library/postgres:17.6-bookworm",
  infra: "docker.io/library/alpine:3.21.3",
} as const;

export async function podman(args: readonly string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("podman", [...args], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    // Never echo arguments: they may reference credential files.
    throw new Error(`podman ${args[0]} failed (${(error as { code?: unknown }).code ?? "error"})`);
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")));
    });
  });
}

export async function waitFor(probe: () => Promise<boolean>, seconds: number, what: string): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export interface DaprStack {
  readonly pod: string;
  readonly grpcPort: number;
  readonly httpPort: number;
  readonly remove: () => Promise<void>;
}

/** Ephemeral Dapr pod whose only host exposure is two loopback-published ports. */
export async function startDapr(runtimeRoot: string, label = "p4-05"): Promise<DaprStack> {
  const info = JSON.parse(await podman(["info", "--format", "json"])) as { host?: { security?: { rootless?: boolean } } };
  if (info.host?.security?.rootless !== true) throw new Error("Rootless Podman is required");
  const pod = `myforge-${label}-${randomBytes(4).toString("hex")}`;
  const [grpcPort, httpPort] = [await freePort(), await freePort()];
  const components = join(runtimeRoot, "components");
  await mkdir(components, { recursive: true, mode: 0o755 });
  await chmod(components, 0o755);
  const password = randomBytes(24).toString("hex");
  const postgresEnv = join(runtimeRoot, "postgres.env");
  const daprEnv = join(runtimeRoot, "dapr.env");
  await writeFile(postgresEnv, `POSTGRES_PASSWORD=${password}\nPOSTGRES_USER=dapr\nPOSTGRES_DB=dapr\n`, { mode: 0o600 });
  await writeFile(daprEnv, `P405_STATE_URL=host=127.0.0.1 port=5432 user=dapr password=${password} dbname=dapr sslmode=disable\n`, { mode: 0o600 });
  await writeFile(join(components, "state.yaml"), `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: workflowstate
spec:
  type: state.postgresql
  version: v2
  metadata:
    - name: connectionString
      secretKeyRef:
        name: P405_STATE_URL
        key: P405_STATE_URL
    - name: actorStateStore
      value: "true"
auth:
  secretStore: p405env
`, { mode: 0o644 });
  await writeFile(join(components, "env.yaml"), `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: p405env
spec:
  type: secretstores.local.env
  version: v1
`, { mode: 0o644 });

  const remove = async () => {
    await podman(["pod", "rm", "--force", "--time", "10", pod], true);
  };
  const run = (name: string, image: string, args: readonly string[], options: readonly string[] = []) =>
    podman(["run", "--detach", "--pull=never", "--name", `${pod}-${name}`, "--pod", pod,
      "--security-opt", "no-new-privileges", ...options, image, ...args]);
  try {
    await podman(["pod", "create", "--name", pod, "--infra-image", IMAGES.infra,
      "--infra-command", "/bin/sleep infinity",
      "--publish", `127.0.0.1:${grpcPort}:50001`, "--publish", `127.0.0.1:${httpPort}:3500`]);
    await run("postgres", IMAGES.postgres, [], ["--env-file", postgresEnv]);
    await waitFor(async () => (await podman(["exec", `${pod}-postgres`, "pg_isready", "-U", "dapr", "-d", "dapr"], true)) !== "", 90, "Dapr state PostgreSQL");
    await run("placement", IMAGES.placement, ["/placement", "--port", "50005", "--healthz-port", "8080", "--enable-metrics=false"]);
    await run("scheduler", IMAGES.scheduler, ["/scheduler", "--port", "50006", "--healthz-port", "8081",
      "--etcd-data-dir", "/tmp/etcd", "--override-broadcast-host-port", "127.0.0.1:50006", "--enable-metrics=false"]);
    await run("daprd", IMAGES.daprd, ["/daprd", "--app-id", `myforge-${label}`, "--resources-path", "/components",
      "--placement-host-address", "127.0.0.1:50005", "--scheduler-host-address", "127.0.0.1:50006",
      "--dapr-grpc-port", "50001", "--dapr-http-port", "3500",
      "--dapr-listen-addresses", "0.0.0.0", "--enable-metrics=false", "--log-level", "warn"],
    ["--env", "DAPR_HOST_IP=127.0.0.1", "--env-file", daprEnv, "--volume", `${components}:/components:ro,Z`]);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${httpPort}/v1.0/healthz/outbound`, { signal: AbortSignal.timeout(2_000) })).ok, 120, "daprd");
  } catch (error) {
    await remove();
    throw error;
  }
  return { pod, grpcPort, httpPort, remove };
}

/** The Dapr SDK does not forward logger options to its durabletask worker; drop its per-item info lines. */
export function quietDurableTaskInfo(): void {
  for (const method of ["log", "info"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("INFO [DurableTask")) return;
      original(...args);
    };
  }
}
