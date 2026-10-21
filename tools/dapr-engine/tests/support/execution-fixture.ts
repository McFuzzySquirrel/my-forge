import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import {
  computeManifestDigest,
  validateSubmission,
  type RunSubmissionV1,
} from "../../contract/v1/index.ts";
import type { AgentDescriptor, ManifestTask } from "../../execution/types.ts";
import type { AcceptedRunSubmissionV1 } from "../../orchestration/planner.ts";
import {
  FileArtifactCheckpointStore,
  PostgresControlRecordStore,
  PostgresExecutionOwnershipStore,
  PostgresOperationReceiptStore,
  PostgresRepositoryIntegrationAuthority,
  PostgresRunStatusStore,
} from "../../storage/index.ts";

export const TARGET_REF = "refs/heads/main";
const MIGRATIONS = [
  "repository-integration.sql",
  "operation-receipts.sql",
  "operation-executions.sql",
  "control-records.sql",
  "run-status.sql",
  "run-definition-versions.sql",
];

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

export interface ExecutionFixture {
  readonly root: string;
  readonly scratchRoot: string;
  readonly target: string;
  readonly repositoryId: string;
  readonly base: string;
  readonly database: Pool;
  readonly schema: string;
  readonly checkpoints: FileArtifactCheckpointStore;
  readonly receipts: PostgresOperationReceiptStore;
  readonly executions: PostgresExecutionOwnershipStore;
  readonly integration: PostgresRepositoryIntegrationAuthority;
  readonly controls: PostgresControlRecordStore;
  readonly status: PostgresRunStatusStore;
  /** Resolves every target repository registered with this fixture. */
  readonly repositoryRoot: (repositoryId: string) => string | undefined;
  /** Adds another disposable target repository on `main`. */
  readonly addTarget: (label: string, files?: Readonly<Record<string, string>>) => Promise<FixtureTarget>;
  readonly cleanup: () => Promise<void>;
}

export interface FixtureTarget {
  readonly repositoryId: string;
  readonly target: string;
  readonly base: string;
}

async function createTarget(path: string, files: Readonly<Record<string, string>>): Promise<string> {
  git(dirname(path), ["init", "--quiet", "--initial-branch=main", path]);
  git(path, ["config", "user.name", "MyForge fixture"]);
  git(path, ["config", "user.email", "myforge-fixture@example.invalid"]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "base"]);
  const base = git(path, ["rev-parse", "HEAD"]);
  git(path, ["checkout", "--quiet", "--detach"]);
  return base;
}

/**
 * Creates a disposable PostgreSQL schema with every engine migration, a
 * detached target repository on `main`, and a scratch root outside the host
 * home. `keep` retains files and schema for manual inspection.
 */
export async function createExecutionFixture(
  connectionString: string,
  options: { readonly label?: string; readonly keep?: boolean; readonly files?: Readonly<Record<string, string>> } = {},
): Promise<ExecutionFixture> {
  const label = options.label ?? "exec";
  const schema = `${label.replace(/[^a-z0-9_]/g, "_")}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const root = await realpath(await mkdtemp(join(tmpdir(), `myforge-${label}-`)));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  for (const file of MIGRATIONS) {
    await database.query(await readFile(new URL(`../../storage/postgres/${file}`, import.meta.url), "utf8"));
  }

  const defaultFiles = { "README.md": "# Fixture target\n" };
  const target = join(root, "target");
  const base = await createTarget(target, options.files ?? defaultFiles);
  const repositoryId = `repo_${label}`;
  const targets = new Map<string, string>([[repositoryId, target]]);
  const repositoryRoot = (id: string) => targets.get(id);
  const checkpoints = new FileArtifactCheckpointStore(join(root, "artifact-store"));
  return {
    root,
    scratchRoot: join(root, "scratch"),
    target,
    repositoryId,
    base,
    database,
    schema,
    checkpoints,
    receipts: new PostgresOperationReceiptStore(database),
    executions: new PostgresExecutionOwnershipStore(database),
    integration: new PostgresRepositoryIntegrationAuthority(
      database,
      repositoryRoot,
      checkpoints,
    ),
    controls: new PostgresControlRecordStore(database),
    status: new PostgresRunStatusStore(database),
    repositoryRoot,
    addTarget: async (name, extra) => {
      const id = `repo_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      if (targets.has(id)) throw new Error(`Fixture target '${id}' already exists`);
      const path = join(root, `target-${name}`);
      const targetBase = await createTarget(path, extra ?? defaultFiles);
      targets.set(id, path);
      return { repositoryId: id, target: path, base: targetBase };
    },
    cleanup: async () => {
      await database.end();
      if (options.keep) return;
      const dropper = new Pool({ connectionString });
      try {
        await dropper.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await dropper.end();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface TaskSpec {
  readonly id: string;
  readonly ownerAgent: string;
  readonly dependencies?: readonly string[];
  readonly expectedOutputs?: readonly string[];
  readonly validationCommands?: readonly string[];
  readonly approvalRequired?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export function manifestTask(spec: TaskSpec): ManifestTask {
  return {
    id: spec.id,
    contract: {
      version: 1,
      kind: "implementation",
      requirements: [spec.description ?? `Implement ${spec.id}.`],
      acceptanceCriteria: [...(spec.acceptanceCriteria ?? [`${spec.id} outputs exist and validation passes.`])],
      constraints: [],
      references: ["README.md"],
    },
    title: spec.title ?? `Task ${spec.id}`,
    description: spec.description ?? `Implement ${spec.id}.`,
    ownerAgent: spec.ownerAgent,
    requiredCapabilities: ["repository-tools"],
    dependencies: [...(spec.dependencies ?? [])],
    expectedOutputs: [...(spec.expectedOutputs ?? [])],
    validationCommands: [...(spec.validationCommands ?? [])],
    approvalRequired: spec.approvalRequired ?? false,
    sourceLines: [],
  } as ManifestTask;
}

export function agent(name: string): AgentDescriptor {
  return {
    name,
    description: `${name} fixture agent`,
    path: `.github/agents/${name}.md`,
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: `You are ${name}.`,
  };
}

/** Builds and validates an accepted submission with its frozen effective selection. */
export function acceptedSubmission(options: {
  readonly repositoryId: string;
  readonly phases: readonly { readonly id: string; readonly dependencies?: readonly string[]; readonly tasks: readonly ManifestTask[] }[];
  readonly selection?: { readonly mode: "auto" | "manual"; readonly requestedTaskIds: readonly string[] };
  readonly settings?: Readonly<Record<string, number | boolean>>;
  readonly harnessId?: string;
  readonly secretRefs?: Readonly<Record<string, { readonly ref: string }>>;
}): AcceptedRunSubmissionV1 {
  const manifestSnapshot = { version: "1.0", phases: options.phases.map((phase) => ({ ...phase })) };
  const submission: RunSubmissionV1 = {
    schemaVersion: 1,
    submissionKey: randomUUID(),
    repositoryId: options.repositoryId,
    targetRef: TARGET_REF,
    manifestSnapshot: manifestSnapshot as unknown as RunSubmissionV1["manifestSnapshot"],
    manifestDigest: computeManifestDigest(manifestSnapshot as unknown as RunSubmissionV1["manifestSnapshot"]),
    selection: { mode: options.selection?.mode ?? "auto", requestedTaskIds: [...(options.selection?.requestedTaskIds ?? [])] },
    harness: { id: options.harnessId ?? "scripted-stub", adapterVersion: "1" },
    configuration: {
      settings: { concurrency: 1, maxRetries: 1, retryDelayMs: 1_000, ...options.settings },
      secretRefs: { ...options.secretRefs },
    },
    workflowDefinitionVersion: "p4-05@1",
  };
  const validation = validateSubmission(submission);
  if (!validation.ok) throw new Error(`Submission rejected: ${validation.code} ${validation.detail}`);
  return {
    ...submission,
    selection: { ...submission.selection, effectiveTaskIds: validation.effectiveTaskIds },
  } as AcceptedRunSubmissionV1;
}
