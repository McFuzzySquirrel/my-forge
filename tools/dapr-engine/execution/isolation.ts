import { chmod, chown, lchown, mkdir, mkdtemp, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ProcessIdentityV1 } from "./types.ts";

/**
 * Process isolation policy for supervised harness executions (contract v1 §3
 * "Process lifecycle and isolation"). A harness receives an allowlisted
 * environment, a disposable per-attempt home, and explicitly bound
 * credentials. It never inherits the worker's home directory, container-engine
 * endpoints, Dapr/application tokens, agent sockets, or database settings.
 */

const PASS_THROUGH = new Set([
  "PATH", "LANG", "LANGUAGE", "TZ", "TERM", "NO_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR",
]);
const PASS_THROUGH_PATTERN = /^LC_[A-Z]+$/;
const TASK_UID_FIRST = 20_000;
const TASK_UID_LAST = 60_000;
const activeTaskUids = new Set<number>();
const usedTaskUids = new Set<number>();
const quarantinedTaskUids = new Set<number>();
let nextTaskUid = TASK_UID_FIRST;

/** Allocate a distinct UID per live task so one task cannot inspect another's process environment. */
export function allocateTaskProcessIdentity(): ProcessIdentityV1 {
  for (let attempt = 0; attempt <= TASK_UID_LAST - TASK_UID_FIRST; attempt += 1) {
    const uid = nextTaskUid;
    nextTaskUid = uid === TASK_UID_LAST ? TASK_UID_FIRST : uid + 1;
    if (usedTaskUids.has(uid)) continue;
    activeTaskUids.add(uid);
    usedTaskUids.add(uid);
    return { uid, gid: uid };
  }
  throw new Error("No task process identities are available; wait for active attempts to finish.");
}

export function releaseTaskProcessIdentity(identity: ProcessIdentityV1): void {
  if (!activeTaskUids.delete(identity.uid)) {
    throw new Error(`Task process identity ${identity.uid} was not allocated or was already released.`);
  }
  if (!quarantinedTaskUids.delete(identity.uid)) usedTaskUids.delete(identity.uid);
}

export function taskProcessPrivilegeArgs(identity: ProcessIdentityV1): string[] {
  return [
    "--reuid", String(identity.uid),
    "--regid", String(identity.gid),
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
  ];
}

export function quarantineTaskProcessIdentity(identity: ProcessIdentityV1): void {
  if (!activeTaskUids.has(identity.uid)) {
    throw new Error(`Cannot quarantine inactive task process identity ${identity.uid}.`);
  }
  quarantinedTaskUids.add(identity.uid);
}

/** Assign a task-owned workspace without following repository-controlled symlinks. */
export async function chownTaskTree(path: string, identity: ProcessIdentityV1): Promise<void> {
  const directory = await opendir(path);
  await directory.close();
  const visit = async (current: string): Promise<void> => {
    const entries = await opendir(current);
    for await (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) await lchown(child, identity.uid, identity.gid);
      else if (entry.isDirectory()) {
        await chown(child, identity.uid, identity.gid);
        await visit(child);
      } else {
        await chown(child, identity.uid, identity.gid);
      }
    }
    await chown(current, identity.uid, identity.gid);
  };
  await visit(path);
}

/** Variables that grant engine, host, or service access, or are set by the policy itself. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^(DOCKER|PODMAN|CONTAINERS?|BUILDKIT|CONTAINERD|BUILDAH)_/,
  /^(KUBECONFIG|NERDCTL_.*)$/,
  /^(DAPR_.*|APP_API_TOKEN|MYFORGE_.*)$/,
  /^(SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY)$/,
  /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|PWD)$/,
  /^XDG_[A-Z_]+$/,
  /^(PG[A-Z]+|DATABASE_URL|POSTGRES_[A-Z_]+)$/,
  /^(LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|BASH_ENV|ENV)$/,
  /^GIT_/,
];

export function isForbiddenHarnessVariable(name: string): boolean {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name));
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!!path && !path.startsWith("..") && !isAbsolute(path));
}

/** True when `path` is the host home, inside it, or an ancestor that exposes it. */
export function overlapsHostHome(path: string, hostHome = homedir()): boolean {
  const target = resolve(path);
  const home = resolve(hostHome);
  return contains(home, target) || contains(target, home);
}

export interface HarnessHome {
  readonly home: string;
  readonly config: string;
  readonly cache: string;
  readonly data: string;
  readonly state: string;
  readonly tmp: string;
}

function harnessHomeLayout(home: string): HarnessHome {
  return {
    home,
    config: join(home, ".config"),
    cache: join(home, ".cache"),
    data: join(home, ".local", "share"),
    state: join(home, ".local", "state"),
    tmp: join(home, "tmp"),
  };
}

/**
 * Creates an owner-only home for one execution epoch below an operator-supplied
 * scratch root. The root must not overlap the worker's host home.
 */
export async function createHarnessHome(scratchRoot: string, options: {
  readonly hostHome?: string;
  readonly processIdentity?: ProcessIdentityV1;
} = {}): Promise<HarnessHome> {
  if (!isAbsolute(scratchRoot)) throw new Error("Harness scratch root must be an absolute path");
  if (overlapsHostHome(scratchRoot, options.hostHome)) {
    throw new Error("Harness scratch root must not be, contain, or be inside the host home directory");
  }
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  if (options.processIdentity) await chmod(scratchRoot, 0o711);
  const layout = harnessHomeLayout(await mkdtemp(join(resolve(scratchRoot), "home-")));
  for (const directory of [layout.config, layout.cache, layout.data, layout.state, layout.tmp]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  if (options.processIdentity) await chownTaskTree(layout.home, options.processIdentity);
  return layout;
}

export interface HarnessEnvironmentOptions {
  /** Absolute per-attempt home, normally from `createHarnessHome`. */
  readonly home: string;
  /** Source of pass-through values; defaults to the worker environment. */
  readonly inherited?: NodeJS.ProcessEnv;
  /** Additional non-secret variable names to copy from `inherited`. */
  readonly passThrough?: readonly string[];
  /** Explicitly bound credential variables for the selected harness only. */
  readonly credentials?: Readonly<Record<string, string>>;
  readonly hostHome?: string;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkVariable(name: string, purpose: string): void {
  if (!VARIABLE_NAME.test(name)) throw new Error(`Invalid ${purpose} variable name: ${name}`);
  if (isForbiddenHarnessVariable(name)) throw new Error(`${purpose} variable ${name} is reserved by the process isolation policy`);
}

/**
 * Builds the complete environment for an isolated harness process. Only the
 * allowlist and named pass-through variables are copied; home and temporary
 * directories point into the per-attempt home.
 */
export function buildHarnessEnvironment(options: HarnessEnvironmentOptions): Record<string, string> {
  if (!isAbsolute(options.home)) throw new Error("Harness home must be an absolute path");
  if (overlapsHostHome(options.home, options.hostHome)) {
    throw new Error("Harness home must not be, contain, or be inside the host home directory");
  }
  const inherited = options.inherited ?? process.env;
  const environment: Record<string, string> = {};
  const extra = new Set(options.passThrough ?? []);
  for (const name of extra) checkVariable(name, "Pass-through");
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (PASS_THROUGH.has(name) || PASS_THROUGH_PATTERN.test(name) || extra.has(name)) environment[name] = value;
  }
  const layout = harnessHomeLayout(resolve(options.home));
  Object.assign(environment, {
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.config,
    XDG_CACHE_HOME: layout.cache,
    XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state,
    TMPDIR: layout.tmp,
  });
  if (process.platform === "win32") Object.assign(environment, { USERPROFILE: layout.home, TEMP: layout.tmp, TMP: layout.tmp });
  for (const [name, value] of Object.entries(options.credentials ?? {})) {
    checkVariable(name, "Credential");
    if (value.includes("\0")) throw new Error(`Credential variable ${name} contains a NUL byte`);
    environment[name] = value;
  }
  return environment;
}

export interface ContainerMountSpec {
  readonly type: "bind" | "volume" | "tmpfs";
  /** Host path for binds, volume name for volumes. */
  readonly source?: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface ContainerIsolationSpec {
  readonly mounts: readonly ContainerMountSpec[];
  readonly privileged?: boolean;
  /** PID namespace mode; `host` shares the host process table. */
  readonly pid?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export type ContainerIsolationViolationCode =
  | "relative-bind-source"
  | "host-home-mount"
  | "engine-socket-mount"
  | "privileged"
  | "host-pid"
  | "engine-endpoint-env";

export interface ContainerIsolationViolation {
  readonly code: ContainerIsolationViolationCode;
  readonly detail: string;
}

const ENGINE_SOCKET_DIRECTORIES = ["/run", "/var/run"];

function exposesEngineSocket(path: string, runtimeDir: string | undefined): boolean {
  const target = resolve(path);
  if (basename(target).endsWith(".sock")) return true;
  const roots = [...ENGINE_SOCKET_DIRECTORIES, ...(runtimeDir ? [resolve(runtimeDir)] : [])];
  // Mounting a runtime directory, or any ancestor of one, exposes every socket below it.
  if (roots.some((root) => contains(target, root))) return true;
  return roots.some((root) => contains(root, target) &&
    /(^|[\\/])(docker|podman|containerd|crio|buildkit|dapr)([\\/.-]|$)/.test(target.slice(root.length)));
}

/**
 * Checks a worker or harness container specification against the isolation
 * policy: no host-home bind, no container-engine or runtime socket, no
 * privileged mode or host PID namespace, and no engine endpoint variables.
 * Named volumes and tmpfs mounts are always allowed.
 */
export function checkContainerIsolation(
  spec: ContainerIsolationSpec,
  options: { readonly hostHome?: string; readonly runtimeDir?: string } = {},
): ContainerIsolationViolation[] {
  const violations: ContainerIsolationViolation[] = [];
  const runtimeDir = options.runtimeDir ?? process.env["XDG_RUNTIME_DIR"];
  for (const mount of spec.mounts) {
    if (mount.type !== "bind") continue;
    const source = mount.source ?? "";
    if (!isAbsolute(source)) {
      violations.push({ code: "relative-bind-source", detail: `${source || "(empty)"} -> ${mount.target}` });
      continue;
    }
    if (overlapsHostHome(source, options.hostHome)) {
      violations.push({ code: "host-home-mount", detail: `${source} -> ${mount.target}` });
    }
    if (exposesEngineSocket(source, runtimeDir) || exposesEngineSocket(mount.target, undefined)) {
      violations.push({ code: "engine-socket-mount", detail: `${source} -> ${mount.target}` });
    }
  }
  if (spec.privileged) violations.push({ code: "privileged", detail: "privileged containers are not permitted" });
  if (spec.pid === "host") violations.push({ code: "host-pid", detail: "the host PID namespace is not permitted" });
  for (const name of Object.keys(spec.environment ?? {})) {
    if (/^(DOCKER_HOST|CONTAINER_HOST|CONTAINER_CONNECTION|BUILDKIT_HOST|CONTAINERD_ADDRESS|DAPR_API_TOKEN|APP_API_TOKEN)$/.test(name)) {
      violations.push({ code: "engine-endpoint-env", detail: name });
    }
  }
  return violations;
}
