import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type {
  ArtifactRefV1,
  DependencyLockfileV1,
  SecretReferenceV1,
  Sha256Digest,
  TaskCheckpointV1,
  ToolchainEntryV1,
} from "../contract/v1/index.ts";
import type {
  ArtifactPublishResult,
  ArtifactResolveResult,
  TaskCheckpointResult,
} from "../storage/files/artifact-checkpoint-store.ts";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RESERVED_CREDENTIAL_ENV =
  /^(?:PATH|PWD|HOME|TEMP|TMP|GIT_|LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$|SHELLOPTS$|PYTHONPATH$|PYTHONHOME$|PERL5OPT$|RUBYOPT$|JAVA_TOOL_OPTIONS$|CLASSPATH$)/i;

export interface WorkspaceCheckpointStore {
  resolveCheckpoint(digest: Sha256Digest): Promise<TaskCheckpointResult>;
  resolveArtifact(ref: ArtifactRefV1): Promise<ArtifactResolveResult>;
}

export interface WorkspaceDependencyProvisionRequest {
  readonly workspacePath: string;
  readonly checkpoint: TaskCheckpointV1;
  readonly lockfiles: readonly DependencyLockfileV1[];
  readonly signal?: AbortSignal;
}

export type WorkspaceDependencyProvisioner =
  (request: WorkspaceDependencyProvisionRequest) => Promise<void>;

export interface ReconstructedWorkspace {
  readonly path: string;
  readonly checkpointDigest: Sha256Digest;
  readonly checkpoint: TaskCheckpointV1;
  readonly dependencies: "not-requested" | "provisioned";
}

export type WorkspaceReconstructionResult =
  | { readonly ok: true; readonly workspace: ReconstructedWorkspace }
  | {
      readonly ok: false;
      readonly code: "checkpoint-missing" | "checkpoint-integrity-failure";
      readonly failures: readonly string[];
    };

export interface WorkspaceReconstructorOptions {
  /** Private scratch root; this implementation never mounts or edits a source checkout. */
  readonly workspaceRoot: string;
  readonly store: WorkspaceCheckpointStore;
  readonly provisionDependencies?: WorkspaceDependencyProvisioner;
}

export interface ReconstructWorkspaceOptions {
  readonly checkpointDigest: Sha256Digest;
  readonly provisionDependencies?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkspaceCredentialBinding {
  /** Name of the secret reference in the immutable run configuration. */
  readonly secretName: string;
  /** Explicit harness environment variable that receives this one secret. */
  readonly environmentVariable: string;
}

export interface WorkspaceSecretResolveRequest {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly harnessId: string;
  readonly secretName: string;
  readonly reference: SecretReferenceV1;
}

export interface WorkspaceCredentialRequest {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly harnessId: string;
  readonly secretRefs: Readonly<Record<string, SecretReferenceV1>>;
  readonly bindings: readonly WorkspaceCredentialBinding[];
}

export interface WorkspaceCredentialResolver {
  resolve(request: WorkspaceSecretResolveRequest): Promise<string>;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

interface CheckpointChange {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted";
  readonly binary: boolean;
  readonly baseBlobOid?: string;
  readonly resultBlobOid?: string;
  readonly baseMode?: string;
  readonly resultMode?: string;
}

function gitEnvironment(home: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"];
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig-disabled"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: home,
    LC_ALL: "C",
  };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        env: { ...gitEnvironment(cwd), ...extraEnv },
        encoding: "buffer",
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const diagnostics = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (error) {
          const detail = diagnostics.trim() || output.toString("utf8").trim();
          reject(new Error(
            `git ${args.join(" ")} failed${error.code !== undefined ? ` (${error.code})` : ""}`
              + `${detail ? `: ${detail}` : `: ${error.message}`}`,
            { cause: error },
          ));
          return;
        }
        resolvePromise(output);
      },
    );
    child.stdin?.end(input);
  });
}

async function gitText(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return (await runGit(cwd, args, signal)).toString("utf8");
}

function safeRelativePath(path: string): boolean {
  const components = path.split("/");
  return path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.includes("\\") &&
    components.every((part) =>
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      !part.includes(":") &&
      !part.endsWith(".") &&
      !part.endsWith(" ") &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}

async function verifySymlinkTarget(
  cwd: string,
  linkPath: string,
  oid: string,
  signal?: AbortSignal,
): Promise<void> {
  const target = (await runGit(cwd, ["cat-file", "blob", oid], signal)).toString("utf8");
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.includes(":") ||
    target.startsWith("/") ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    throw new Error(`Checkpoint contains a symlink that escapes or is invalid: ${linkPath}`);
  }
}

function parseTree(output: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex < 0) throw new Error("Git returned a malformed tree entry");
    const metadata = record.slice(0, separatorIndex).split(" ");
    const path = record.slice(separatorIndex + 1);
    const [mode, type, oid] = metadata;
    if (!mode || !type || !oid || !GIT_OID_PATTERN.test(oid) || !safeRelativePath(path)) {
      throw new Error(`Checkpoint contains an invalid Git tree path or object: ${path}`);
    }
    if (entries.has(path)) throw new Error(`Checkpoint contains a duplicate Git tree path: ${path}`);
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

async function isBinaryEntry(
  cwd: string,
  entry: TreeEntry,
  signal?: AbortSignal,
): Promise<boolean> {
  if (entry.mode === "160000" || entry.type !== "blob") return true;
  return (await runGit(cwd, ["cat-file", "blob", entry.oid], signal)).includes(0);
}

async function checkpointChanges(
  cwd: string,
  base: ReadonlyMap<string, TreeEntry>,
  result: ReadonlyMap<string, TreeEntry>,
  signal?: AbortSignal,
): Promise<CheckpointChange[]> {
  const paths = [...new Set([...base.keys(), ...result.keys()])].sort();
  const changes: CheckpointChange[] = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = result.get(path);
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    const change = before === undefined ? "added" : after === undefined ? "deleted" : "modified";
    const binaryEntry = after ?? before!;
    changes.push({
      path,
      change,
      binary: await isBinaryEntry(cwd, binaryEntry, signal),
      ...(before ? { baseBlobOid: before.oid, baseMode: before.mode } : {}),
      ...(after ? { resultBlobOid: after.oid, resultMode: after.mode } : {}),
    });
  }
  return changes;
}

async function collectTreeObjects(
  cwd: string,
  treeId: string,
  prefix = "",
  objects = new Set<string>(),
  signal?: AbortSignal,
): Promise<Set<string>> {
  objects.add(treeId);
  const output = await runGit(cwd, ["ls-tree", "-z", treeId], signal);
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex < 0) throw new Error("Git returned a malformed tree entry");
    const [mode, type, oid] = record.slice(0, separatorIndex).split(" ");
    const name = record.slice(separatorIndex + 1);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!mode || !type || !oid || !GIT_OID_PATTERN.test(oid) || !safeRelativePath(path)) {
      throw new Error(`Checkpoint contains an invalid Git tree path or object: ${path}`);
    }
    objects.add(oid);
    if (mode === "120000" && type === "blob") {
      await verifySymlinkTarget(cwd, path, oid, signal);
    }
    if (type === "tree") await collectTreeObjects(cwd, oid, path, objects, signal);
  }
  return objects;
}

function sameChanges(
  actual: readonly CheckpointChange[],
  expected: readonly CheckpointChange[],
): boolean {
  if (actual.length !== expected.length) return false;
  const expectedByPath = new Map(expected.map((change) => [change.path, change]));
  if (expectedByPath.size !== expected.length) return false;
  return actual.every((change) => {
    const other = expectedByPath.get(change.path);
    return other !== undefined &&
      change.change === other.change &&
      change.binary === other.binary &&
      change.baseBlobOid === other.baseBlobOid &&
      change.resultBlobOid === other.resultBlobOid &&
      change.baseMode === other.baseMode &&
      change.resultMode === other.resultMode;
  });
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError(`Workspace root must be a real directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function verifyCheckpointObjects(
  cwd: string,
  checkpoint: TaskCheckpointV1,
  signal?: AbortSignal,
): Promise<void> {
  const declaredIds = checkpoint.gitObjectIds;
  for (const oid of declaredIds) {
    if (!GIT_OID_PATTERN.test(oid)) throw new Error(`Checkpoint contains an invalid Git object ID: ${oid}`);
  }
  if (new Set(declaredIds).size !== declaredIds.length) {
    throw new Error("Checkpoint gitObjectIds contains duplicates");
  }
  if (declaredIds.length > 0) {
    const output = await runGit(
      cwd,
      ["cat-file", "--batch-check"],
      signal,
      `${declaredIds.map((oid) => `${oid}^{object}`).join("\n")}\n`,
    );
    const records = output.toString("utf8").trimEnd().split("\n");
    if (
      records.length !== declaredIds.length ||
      records.some((record, index) =>
        record.endsWith(" missing") ||
        record.split(" ", 1)[0] !== declaredIds[index])
    ) {
      throw new Error("Checkpoint Git bundle is missing one or more declared objects");
    }
  }
  const baseType = (await gitText(cwd, ["cat-file", "-t", checkpoint.baseRevision], signal)).trim();
  const treeType = (await gitText(cwd, ["cat-file", "-t", checkpoint.gitTreeId], signal)).trim();
  if (baseType !== "commit" || treeType !== "tree") {
    throw new Error("Checkpoint baseRevision or gitTreeId has the wrong Git object type");
  }
  const baseTreeId = (await gitText(cwd, ["rev-parse", `${checkpoint.baseRevision}^{tree}`], signal)).trim();
  const baseTree = parseTree(await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", baseTreeId], signal));
  const resultTree = parseTree(await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", checkpoint.gitTreeId], signal));
  const changes = await checkpointChanges(cwd, baseTree, resultTree, signal);
  if (!sameChanges(changes, checkpoint.changes)) {
    throw new Error("Checkpoint change paths, modes, blob IDs, or binary flags do not match its Git trees");
  }
  const requiredObjects = new Set([
    checkpoint.baseRevision,
    ...await collectTreeObjects(cwd, baseTreeId, "", new Set(), signal),
    ...await collectTreeObjects(cwd, checkpoint.gitTreeId, "", new Set(), signal),
  ]);
  const declaredObjects = new Set(checkpoint.gitObjectIds);
  const missing = [...requiredObjects].filter((oid) => !declaredObjects.has(oid));
  if (missing.length > 0) {
    throw new Error(`Checkpoint gitObjectIds omit required Git objects: ${missing.join(", ")}`);
  }
}

async function verifyLockfiles(
  cwd: string,
  checkpoint: TaskCheckpointV1,
  store: WorkspaceCheckpointStore,
  signal?: AbortSignal,
): Promise<void> {
  const tree = parseTree(await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", checkpoint.gitTreeId], signal));
  for (const lockfile of checkpoint.dependencyLockfiles) {
    if (!safeRelativePath(lockfile.path)) throw new Error(`Unsafe dependency lockfile path: ${lockfile.path}`);
    const entry = tree.get(lockfile.path);
    if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(`Dependency lockfile is not a regular file in the checkpoint tree: ${lockfile.path}`);
    }
    const artifact = await store.resolveArtifact(lockfile.artifact);
    if (!artifact.ok) throw new Error(`Dependency lockfile artifact failed integrity verification: ${artifact.code}`);
    const file = await readFile(join(cwd, lockfile.path));
    if (!file.equals(Buffer.from(artifact.bytes))) {
      throw new Error(`Dependency lockfile bytes do not match the checkpoint artifact: ${lockfile.path}`);
    }
  }
}

export class CheckpointWorkspaceReconstructor {
  private readonly root: string;
  private readonly store: WorkspaceCheckpointStore;
  private readonly provisioner?: WorkspaceDependencyProvisioner;

  constructor(options: WorkspaceReconstructorOptions) {
    if (!isAbsolute(options.workspaceRoot)) throw new TypeError("Workspace root must be an absolute path");
    this.root = resolve(options.workspaceRoot);
    this.store = options.store;
    this.provisioner = options.provisionDependencies;
  }

  async reconstruct(options: ReconstructWorkspaceOptions): Promise<WorkspaceReconstructionResult> {
    options.signal?.throwIfAborted();
    const checkpointResult = await this.store.resolveCheckpoint(options.checkpointDigest);
    if (!checkpointResult.ok) {
      return {
        ok: false,
        code: checkpointResult.code,
        failures: checkpointResult.failures,
      };
    }
    if (checkpointResult.digest !== options.checkpointDigest) {
      return {
        ok: false,
        code: "checkpoint-integrity-failure",
        failures: ["resolved checkpoint digest differs from the requested digest"],
      };
    }
    if (options.provisionDependencies && !this.provisioner) {
      throw new Error("Dependency provisioning was requested but no workspace-scoped provisioner is configured");
    }

    const bundle = await this.store.resolveArtifact(checkpointResult.checkpoint.gitObjectBundle);
    if (!bundle.ok) {
      return {
        ok: false,
        code: "checkpoint-integrity-failure",
        failures: [`Git object bundle failed integrity verification: ${bundle.code}`],
      };
    }

    await ensureDirectory(this.root);
    const workspacePath = await mkdtemp(join(this.root, "workspace-"));
    let bundleDirectory: string | undefined;
    try {
      options.signal?.throwIfAborted();
      bundleDirectory = await mkdtemp(join(tmpdir(), "myforge-checkpoint-"));
      const bundlePath = join(bundleDirectory, "checkpoint.bundle");
      await writeFile(bundlePath, Buffer.from(bundle.bytes), { flag: "wx", mode: 0o600 });
      await gitText(workspacePath, ["init", "--quiet"], options.signal);
      await gitText(workspacePath, ["bundle", "verify", bundlePath], options.signal);
      await gitText(workspacePath, ["fetch", "--no-tags", bundlePath], options.signal);
      await gitText(workspacePath, ["checkout", "--detach", checkpointResult.checkpoint.baseRevision], options.signal);
      await verifyCheckpointObjects(workspacePath, checkpointResult.checkpoint, options.signal);
      await gitText(workspacePath, [
        "restore",
        `--source=${checkpointResult.checkpoint.gitTreeId}`,
        "--worktree",
        "--",
        ".",
      ], options.signal);
      await verifyLockfiles(workspacePath, checkpointResult.checkpoint, this.store, options.signal);

      if (options.provisionDependencies) {
        await this.provisioner!({
          workspacePath,
          checkpoint: checkpointResult.checkpoint,
          lockfiles: checkpointResult.checkpoint.dependencyLockfiles,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        options.signal?.throwIfAborted();
      }
      await rm(bundleDirectory, { recursive: true, force: true });
      bundleDirectory = undefined;
      return {
        ok: true,
        workspace: {
          path: workspacePath,
          checkpointDigest: checkpointResult.digest,
          checkpoint: checkpointResult.checkpoint,
          dependencies: options.provisionDependencies ? "provisioned" : "not-requested",
        },
      };
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await rm(workspacePath, { recursive: true, force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (bundleDirectory) {
        try {
          await rm(bundleDirectory, { recursive: true, force: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Workspace reconstruction and cleanup both failed");
      throw error;
    }
  }

  async destroy(workspace: Pick<ReconstructedWorkspace, "path">): Promise<void> {
    const path = resolve(workspace.path);
    const name = basename(path);
    if (!within(this.root, path) || !name.startsWith("workspace-") || relative(this.root, path).includes(sep)) {
      throw new TypeError("Refusing to remove a workspace outside the configured root");
    }
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Managed workspace path is not a directory");
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Resolve only explicitly bound secrets for one repository, target ref, and
 * harness. Returned values are environment entries, never workspace files.
 */
export async function resolveWorkspaceCredentialEnvironment(
  request: WorkspaceCredentialRequest,
  resolver: WorkspaceCredentialResolver,
): Promise<Readonly<Record<string, string>>> {
  if (!request.repositoryId || !request.targetRef || !request.harnessId) {
    throw new TypeError("Repository, target ref, and harness identity are required to resolve workspace credentials");
  }
  const environment = Object.create(null) as Record<string, string>;
  const secretNames = new Set<string>();
  const environmentNames = new Set<string>();
  for (const binding of request.bindings) {
    if (!binding.secretName || secretNames.has(binding.secretName)) {
      throw new TypeError(`Invalid or duplicate workspace secret binding: ${binding.secretName}`);
    }
    secretNames.add(binding.secretName);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.environmentVariable) ||
        RESERVED_CREDENTIAL_ENV.test(binding.environmentVariable)) {
      throw new TypeError(`Secret binding uses a reserved or invalid environment variable: ${binding.environmentVariable}`);
    }
    const environmentName = process.platform === "win32"
      ? binding.environmentVariable.toUpperCase()
      : binding.environmentVariable;
    if (environmentNames.has(environmentName)) {
      throw new TypeError(`Duplicate workspace credential environment variable: ${binding.environmentVariable}`);
    }
    environmentNames.add(environmentName);
    const reference = request.secretRefs[binding.secretName];
    if (!reference || !reference.ref) {
      throw new TypeError(`Workspace secret binding has no configured reference: ${binding.secretName}`);
    }
    const value = await resolver.resolve({
      repositoryId: request.repositoryId,
      targetRef: request.targetRef,
      harnessId: request.harnessId,
      secretName: binding.secretName,
      reference,
    });
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new Error(`Credential resolver returned no value for secret reference ${binding.secretName}`);
    }
    environment[binding.environmentVariable] = value;
  }
  return Object.freeze(environment);
}

export interface WorkspaceCheckpointPublisher {
  publishArtifact(
    bytes: Uint8Array,
    declared: Pick<ArtifactRefV1, "mediaType" | "sizeBytes" | "sha256"> &
      Partial<Pick<ArtifactRefV1, "sensitivity" | "retentionClass">>,
  ): Promise<ArtifactPublishResult>;
  publishCheckpoint(checkpoint: TaskCheckpointV1): Promise<TaskCheckpointResult>;
}

export interface CaptureWorkspaceCheckpointOptions {
  /** Git working tree whose current files (tracked and untracked, honouring .gitignore) are captured. */
  readonly workspacePath: string;
  /** Commit the captured changes are relative to; the result commit's only parent. */
  readonly baseRevision: string;
  readonly runId: string;
  readonly manifestDigest: Sha256Digest;
  readonly publisher: WorkspaceCheckpointPublisher;
  readonly parentCheckpointDigest?: Sha256Digest;
  /** Already-published validation evidence (test output, reports); at least one is required. */
  readonly validationEvidence: readonly ArtifactRefV1[];
  readonly toolchain?: readonly ToolchainEntryV1[];
  /** Regular files in the captured tree to publish as dependency lockfiles. */
  readonly dependencyLockfilePaths?: readonly string[];
  readonly commitMessage?: string;
  /** Fixed commit time (ISO-8601); defaults to the capture time. */
  readonly commitDate?: string;
  readonly signal?: AbortSignal;
}

export type WorkspaceCaptureResult =
  | {
      readonly ok: true;
      readonly digest: Sha256Digest;
      readonly checkpoint: TaskCheckpointV1;
      /** Commit with tree gitTreeId and sole parent baseRevision, present in the bundle. */
      readonly resultCommit: string;
    }
  | {
      readonly ok: false;
      readonly code: "artifact-publish-failure" | "checkpoint-integrity-failure" | "checkpoint-missing";
      readonly failures: readonly string[];
    };

const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "MyForge checkpoint",
  GIT_AUTHOR_EMAIL: "checkpoint@myforge.invalid",
  GIT_COMMITTER_NAME: "MyForge checkpoint",
  GIT_COMMITTER_EMAIL: "checkpoint@myforge.invalid",
};

function digestOf(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function publishBytes(
  publisher: WorkspaceCheckpointPublisher,
  bytes: Uint8Array,
  mediaType: string,
): Promise<ArtifactPublishResult> {
  return publisher.publishArtifact(bytes, {
    mediaType,
    sizeBytes: bytes.byteLength,
    sha256: digestOf(bytes),
    retentionClass: "checkpoint-evidence",
  });
}

/**
 * Capture a workspace as an immutable task checkpoint: the working tree is
 * staged into a private index (the workspace index and refs are untouched),
 * committed on top of baseRevision, bundled with its history, and published
 * with its change list and object inventory so that
 * CheckpointWorkspaceReconstructor can rebuild the same tree elsewhere.
 */
export async function captureWorkspaceCheckpoint(
  options: CaptureWorkspaceCheckpointOptions,
): Promise<WorkspaceCaptureResult> {
  const { workspacePath, publisher, signal } = options;
  if (!isAbsolute(workspacePath)) throw new TypeError("Workspace path must be absolute");
  if (!GIT_OID_PATTERN.test(options.baseRevision)) throw new TypeError("Base revision must be a full Git object ID");
  signal?.throwIfAborted();

  const scratch = await mkdtemp(join(tmpdir(), "myforge-capture-"));
  try {
    const baseType = (await gitText(workspacePath, ["cat-file", "-t", options.baseRevision], signal)).trim();
    if (baseType !== "commit") throw new TypeError("Base revision is not a commit in the workspace");

    const indexEnv = { GIT_INDEX_FILE: join(scratch, "index") };
    await runGit(workspacePath, ["read-tree", options.baseRevision], signal, undefined, indexEnv);
    await runGit(workspacePath, ["add", "-A", "--", "."], signal, undefined, indexEnv);
    const gitTreeId = (await runGit(workspacePath, ["write-tree"], signal, undefined, indexEnv)).toString("utf8").trim();
    const commitDate = options.commitDate ?? new Date().toISOString();
    const resultCommit = (await runGit(
      workspacePath,
      ["commit-tree", gitTreeId, "-p", options.baseRevision, "-F", "-"],
      signal,
      options.commitMessage ?? `MyForge checkpoint for ${options.runId}\n`,
      { ...CHECKPOINT_IDENTITY, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
    )).toString("utf8").trim();

    const baseTreeId = (await gitText(workspacePath, ["rev-parse", `${options.baseRevision}^{tree}`], signal)).trim();
    const baseTree = parseTree(await runGit(workspacePath, ["ls-tree", "-r", "-z", "--full-tree", baseTreeId], signal));
    const resultTree = parseTree(await runGit(workspacePath, ["ls-tree", "-r", "-z", "--full-tree", gitTreeId], signal));
    const changes = await checkpointChanges(workspacePath, baseTree, resultTree, signal);
    const gitObjectIds = [...new Set([
      options.baseRevision,
      resultCommit,
      ...await collectTreeObjects(workspacePath, baseTreeId, "", new Set(), signal),
      ...await collectTreeObjects(workspacePath, gitTreeId, "", new Set(), signal),
    ])];

    // Bundle from a scratch repository that borrows the workspace objects, so
    // the bundle carries a HEAD for the result commit without adding refs to the workspace.
    const objectDirectory = resolve(workspacePath, (await gitText(workspacePath, ["rev-parse", "--git-path", "objects"], signal)).trim());
    const bundleRepository = join(scratch, "bundle.git");
    await gitText(scratch, ["init", "--quiet", "--bare", bundleRepository], signal);
    await writeFile(join(bundleRepository, "objects", "info", "alternates"), `${objectDirectory}\n`);
    await gitText(bundleRepository, ["update-ref", "refs/heads/checkpoint", resultCommit], signal);
    await gitText(bundleRepository, ["symbolic-ref", "HEAD", "refs/heads/checkpoint"], signal);
    const bundlePath = join(scratch, "checkpoint.bundle");
    await gitText(bundleRepository, ["bundle", "create", bundlePath, "--all"], signal);

    const failures: string[] = [];
    const bundle = await publishBytes(publisher, await readFile(bundlePath), "application/vnd.git.bundle");
    if (!bundle.ok) failures.push(`git object bundle: ${bundle.code}`);
    const dependencyLockfiles: DependencyLockfileV1[] = [];
    for (const path of new Set(options.dependencyLockfilePaths ?? [])) {
      const entry = safeRelativePath(path) ? resultTree.get(path) : undefined;
      if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        throw new TypeError(`Dependency lockfile is not a regular file in the captured tree: ${path}`);
      }
      const published = await publishBytes(
        publisher,
        await runGit(workspacePath, ["cat-file", "blob", entry.oid], signal),
        "application/octet-stream",
      );
      if (published.ok) dependencyLockfiles.push({ path, artifact: published.ref });
      else failures.push(`dependency lockfile ${path}: ${published.code}`);
    }
    if (!bundle.ok || failures.length > 0) {
      return { ok: false, code: "artifact-publish-failure", failures };
    }

    const validationEvidence = [...options.validationEvidence];
    const checkpoint: TaskCheckpointV1 = {
      schemaVersion: 1,
      runId: options.runId,
      manifestDigest: options.manifestDigest,
      ...(options.parentCheckpointDigest ? { parentCheckpointDigest: options.parentCheckpointDigest } : {}),
      artifacts: [bundle.ref, ...validationEvidence, ...dependencyLockfiles.map((lockfile) => lockfile.artifact)],
      gitTreeId,
      baseRevision: options.baseRevision,
      changes,
      gitObjectIds,
      gitObjectBundle: bundle.ref,
      validationEvidence,
      toolchain: [...(options.toolchain ?? [])],
      dependencyLockfiles,
    };
    const published = await publisher.publishCheckpoint(checkpoint);
    if (!published.ok) return { ok: false, code: published.code, failures: published.failures };
    return { ok: true, digest: published.digest, checkpoint: published.checkpoint, resultCommit };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
