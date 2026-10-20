import { randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Matches the service's `/repositories/<id>` mount names. */
export const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REGISTRY_FILE = "repositories.json";
const OVERRIDE_FILE = "compose.repositories.yaml";

export interface RegisteredRepository {
  readonly id: string;
  readonly path: string;
}

interface RegistryFileV1 {
  readonly version: 1;
  readonly repositories: readonly RegisteredRepository[];
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
}

export async function listRegisteredRepositories(dataDir: string): Promise<RegisteredRepository[]> {
  let text: string;
  try {
    text = await readFile(path.join(dataDir, REGISTRY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<RegistryFileV1>;
  if (parsed.version !== 1 || !Array.isArray(parsed.repositories)) {
    throw new Error(`Registered repositories file is invalid: ${path.join(dataDir, REGISTRY_FILE)}`);
  }
  return parsed.repositories.filter((entry) =>
    typeof entry?.id === "string" && REPOSITORY_ID_PATTERN.test(entry.id) && typeof entry.path === "string"
    && path.isAbsolute(entry.path));
}

async function saveRepositories(dataDir: string, repositories: readonly RegisteredRepository[]): Promise<void> {
  const sorted = [...repositories].sort((left, right) => left.id.localeCompare(right.id));
  await writeAtomic(path.join(dataDir, REGISTRY_FILE), `${JSON.stringify({ version: 1, repositories: sorted }, null, 2)}\n`);
}

/** Default ID: the lowercased directory name with unsupported characters replaced. */
export function defaultRepositoryId(repositoryPath: string): string {
  const slug = path.basename(repositoryPath).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return REPOSITORY_ID_PATTERN.test(slug) ? slug : "repository";
}

export function validateRepositoryMountPath(repositoryPath: string, platform = process.platform): void {
  const withoutDrive = platform === "win32" ? repositoryPath.replace(/^[a-z]:[\\/]/i, "") : repositoryPath;
  if (/[:,\n\r]/.test(withoutDrive)) {
    throw new Error(`Repository paths containing ':', ',' or newlines (except a Windows drive prefix) cannot be mounted: ${repositoryPath}`);
  }
}

/**
 * Registers a repository for the local service. Only its `.git` directory is
 * mounted, so linked worktrees and submodules (whose `.git` is a file) are
 * rejected; the host home and container sockets are never mounted.
 */
export async function registerRepository(
  dataDir: string,
  repositoryPath: string,
  requestedId?: string,
): Promise<RegisteredRepository> {
  const resolved = await realpath(path.resolve(repositoryPath));
  let gitDirectory;
  try {
    gitDirectory = await lstat(path.join(resolved, ".git"));
  } catch {
    throw new Error(`${resolved} is not a Git repository root (no .git directory).`);
  }
  if (!gitDirectory.isDirectory()) {
    throw new Error(`${resolved}/.git is not a directory; linked worktrees and submodules cannot be registered.`);
  }
  validateRepositoryMountPath(resolved);
  const id = requestedId ?? defaultRepositoryId(resolved);
  if (!REPOSITORY_ID_PATTERN.test(id)) {
    throw new Error("Repository IDs must match ^[a-z0-9][a-z0-9_-]{0,63}$.");
  }
  const repositories = await listRegisteredRepositories(dataDir);
  const byPath = repositories.find((entry) => entry.path === resolved);
  if (byPath) {
    if (byPath.id === id || requestedId === undefined) return byPath;
    throw new Error(`${resolved} is already registered as '${byPath.id}'.`);
  }
  if (repositories.some((entry) => entry.id === id)) {
    throw new Error(`Repository ID '${id}' is already registered for another path; choose one with --id.`);
  }
  const entry = { id, path: resolved };
  await saveRepositories(dataDir, [...repositories, entry]);
  return entry;
}

export async function unregisterRepository(dataDir: string, id: string): Promise<boolean> {
  const repositories = await listRegisteredRepositories(dataDir);
  const remaining = repositories.filter((entry) => entry.id !== id);
  if (remaining.length === repositories.length) return false;
  await saveRepositories(dataDir, remaining);
  return true;
}

export async function findRegisteredRepository(dataDir: string, repositoryPath: string): Promise<RegisteredRepository | undefined> {
  const resolved = await realpath(path.resolve(repositoryPath));
  return (await listRegisteredRepositories(dataDir)).find((entry) => entry.path === resolved);
}

/** Compose override mounting each registered `.git` directory read-write; JSON strings are valid YAML. */
export function renderRepositoryOverride(repositories: readonly RegisteredRepository[]): string {
  const volumes = repositories.map((entry) =>
    `      - ${JSON.stringify(`${path.join(entry.path, ".git")}:/repositories/${entry.id}/.git:rw,z`)}`);
  return `# Generated by forge-launcher from ${REGISTRY_FILE}; do not edit.\nservices:\n  forge:\n    volumes:\n${volumes.join("\n")}\n`;
}

/** Writes the override when repositories are registered; returns its path or undefined. */
export async function writeRepositoryOverride(dataDir: string): Promise<string | undefined> {
  const repositories = await listRegisteredRepositories(dataDir);
  const file = path.join(dataDir, OVERRIDE_FILE);
  if (repositories.length === 0) {
    await unlink(file).catch(() => undefined);
    return undefined;
  }
  await writeAtomic(file, renderRepositoryOverride(repositories));
  return file;
}
