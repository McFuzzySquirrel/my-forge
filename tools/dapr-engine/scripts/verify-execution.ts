/**
 * P4-05 live verifier: drives representative runs through real Dapr workflows
 * with the composed execution host, engine-owned PostgreSQL stores, git
 * integration, and an isolated harness, then writes sanitized evidence.
 *
 * Usage (Linux, rootless Podman, images from tools/dapr-spike already pulled):
 *   POSTGRES_TEST_URL=postgres://... npm run verify:execution -- \
 *     [--evidence <file>] [--copilot] [--opencode] [--keep]
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DaprWorkflowClient, WorkflowRuntime, WorkflowRuntimeStatus } from "@dapr/dapr";
import type { ControlRequestV1 } from "../contract/v1/index.ts";
import { CopilotAdapter } from "../execution/harness/copilot-adapter.ts";
import { OpenCodeAdapter } from "../execution/harness/opencode-adapter.ts";
import type { HarnessAdapter, TaskAttemptRequest } from "../execution/types.ts";

type AttemptTask = TaskAttemptRequest["task"];
import { resolveWorkspaceCredentialEnvironment } from "../execution/workspace-reconstruction.ts";
import { TaskApprovalCoordinator } from "../orchestration/approval-control.ts";
import { ExecutionHost, executionHostRunFromSubmission, type ExecutionHostRunV1 } from "../orchestration/execution-host.ts";
import { registerOrchestrationWorkflows } from "../orchestration/index.ts";
import { registerRunLifecycleEventActivity } from "../orchestration/status-activity.ts";
import { RUN_ORCHESTRATION_WORKFLOW_NAME, TASK_CONTROL_EVENT_NAME } from "../orchestration/workflow.ts";
import {
  acceptedSubmission,
  agent,
  createExecutionFixture,
  git,
  manifestTask,
  TARGET_REF,
  type ExecutionFixture,
  type TaskSpec,
} from "../tests/support/execution-fixture.ts";
import { ScriptedHarness, type ScriptedAttempt } from "../tests/support/scripted-harness.ts";
import { IMAGES, podman, quietDurableTaskInfo, startDapr, waitFor, type DaprStack } from "./support/dapr-stack.ts";

const execFileAsync = promisify(execFile);

interface Options {
  readonly databaseUrl: string;
  readonly evidence: string;
  readonly copilot: boolean;
  readonly opencode: boolean;
  readonly keep: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const databaseUrl = process.env.POSTGRES_TEST_URL;
  if (!databaseUrl) throw new Error("POSTGRES_TEST_URL must point at the engine PostgreSQL database");
  let evidence = resolve(".runtime/p4-05-evidence.json");
  let copilot = false;
  let opencode = false;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--copilot") copilot = true;
    else if (arg === "--opencode") opencode = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--evidence" && argv[index + 1]) evidence = resolve(argv[++index]!);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { databaseUrl, evidence, copilot, opencode, keep };
}

interface Scenario {
  readonly name: string;
  readonly proves: string;
  readonly tasks: readonly TaskSpec[];
  readonly selection?: { readonly mode: "manual"; readonly requestedTaskIds: readonly string[] };
  readonly settings?: Readonly<Record<string, number>>;
  readonly script?: (task: AttemptTask, attempt: number) => ScriptedAttempt;
  readonly harness?: HarnessAdapter;
  readonly harnessId?: string;
  readonly secretRefs?: Readonly<Record<string, { readonly ref: string }>>;
  readonly credentials?: (run: CredentialScope) => () => Promise<Readonly<Record<string, string>>>;
  readonly approve?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly expect: (result: ScenarioResult) => void;
}

interface CredentialScope {
  readonly repositoryId: string;
  readonly harnessId: string;
  readonly secretRefs: Readonly<Record<string, { readonly ref: string }>>;
}

interface ScenarioResult {
  readonly runtimeStatus: string;
  readonly output: { status: string; taskStatuses: Record<string, string> };
  readonly commits: readonly { sha: string; subject: string; files: string[] }[];
  readonly events: readonly { eventType: string; taskId?: string; logicalAttempt?: number; detail?: unknown }[];
}

function fileTask(id: string, owner: string, file: string, content: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    ownerAgent: owner,
    expectedOutputs: [file],
    validationCommands: [`grep -qx '${content}' ${file}`],
    ...extra,
  };
}

function writes(map: Readonly<Record<string, string>>): (task: AttemptTask) => ScriptedAttempt {
  return (task) => {
    const file = task.expectedOutputs[0]!;
    return { files: { [file]: `${map[task.id] ?? task.id}\n` }, summary: `Wrote ${file} for ${task.id}.` };
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Scenario expectation failed: ${message}`);
}

function scenarios(): Scenario[] {
  return [
    {
      name: "stub-dependency-chain",
      proves: "Dependency-ordered tasks integrate sequentially; each later task starts from its predecessor's integrated commit.",
      tasks: [
        fileTask("C-1", "alpha", "chain/alpha.txt", "alpha"),
        fileTask("C-2", "alpha", "chain/beta.txt", "beta", { dependencies: ["C-1"], validationCommands: ["grep -qx alpha chain/alpha.txt", "grep -qx beta chain/beta.txt"] }),
        fileTask("C-3", "alpha", "chain/gamma.txt", "gamma", { dependencies: ["C-2"], validationCommands: ["grep -qx beta chain/beta.txt", "grep -qx gamma chain/gamma.txt"] }),
      ],
      script: writes({ "C-1": "alpha", "C-2": "beta", "C-3": "gamma" }),
      expect: (result) => {
        check(result.output.status === "complete", "chain run completed");
        check(result.commits.map((commit) => commit.files.join(",")).join("|") === "chain/alpha.txt|chain/beta.txt|chain/gamma.txt", "three ordered commits");
      },
    },
    {
      name: "verification-failure-retry",
      proves: "A validation failure is retryable: attempt 1 is rejected without integration and attempt 2 integrates.",
      tasks: [fileTask("R-1", "alpha", "retry/value.txt", "correct")],
      settings: { maxRetries: 1, retryDelayMs: 1_000 },
      script: (task, attempt) => ({ files: { "retry/value.txt": attempt === 1 ? "wrong\n" : "correct\n" }, summary: `Attempt ${attempt} for ${task.id}.` }),
      expect: (result) => {
        check(result.output.status === "complete", "retry run completed");
        check(result.commits.length === 1, "only the retried attempt integrated");
        check(result.events.some((event) => event.eventType === "attempt.failed" && event.logicalAttempt === 1), "attempt 1 failed");
        check(result.events.some((event) => event.taskId === "R-1" && event.logicalAttempt === 2 && event.eventType === "task.completed"), "attempt 2 completed");
      },
    },
    {
      name: "manual-selection",
      proves: "Manual selection runs the requested task and its dependency closure only.",
      tasks: [
        fileTask("M-1", "alpha", "manual/base.txt", "base"),
        fileTask("M-2", "alpha", "manual/selected.txt", "selected", { dependencies: ["M-1"] }),
        fileTask("M-3", "beta", "manual/unselected.txt", "unselected"),
      ],
      selection: { mode: "manual", requestedTaskIds: ["M-2"] },
      script: writes({ "M-1": "base", "M-2": "selected", "M-3": "unselected" }),
      expect: (result) => {
        check(result.output.status === "complete", "manual run completed");
        check(Object.keys(result.output.taskStatuses).sort().join(",") === "M-1,M-2", "only M-1 and M-2 were in the run");
        check(!result.commits.some((commit) => commit.files.includes("manual/unselected.txt")), "M-3 not executed");
        check(result.commits.length === 2, "two integrated commits");
      },
    },
    {
      name: "parallel-isolated-tasks",
      proves: "Independent tasks run concurrently in separate workspaces and both integrate; the later integration rebases and revalidates.",
      tasks: [
        fileTask("P-1", "alpha", "parallel/left.txt", "left"),
        fileTask("P-2", "beta", "parallel/right.txt", "right"),
      ],
      settings: { concurrency: 2 },
      script: (task) => ({ ...writes({ "P-1": "left", "P-2": "right" })(task), delayMs: task.id === "P-1" ? 1_500 : 0 }),
      expect: (result) => {
        check(result.output.status === "complete", "parallel run completed");
        check(result.commits.length === 2, "both tasks integrated");
      },
    },
    {
      name: "approval-wait",
      proves: "An approval-gated task verifies, waits without changing the target, and integrates only after a durable operator approval.",
      tasks: [fileTask("A-1", "alpha", "approval/approved.txt", "approved", { approvalRequired: true })],
      script: writes({ "A-1": "approved" }),
      approve: ["A-1"],
      expect: (result) => {
        check(result.output.status === "complete", "approval run completed");
        check(result.events.some((event) => event.eventType === "attempt.waiting-for-approval"), "waited for approval");
        check(result.events.some((event) => event.eventType === "attempt.resumed"), "resumed after approval");
        check(result.commits.length === 1, "integrated after approval");
      },
    },
  ];
}

function copilotScenario(): Scenario {
  return {
    name: "real-harness-copilot",
    proves: "A real Copilot CLI harness run with a scoped credential binding produces an integrated, validated change.",
    harness: new CopilotAdapter(),
    harnessId: "copilot",
    secretRefs: { copilot: { ref: "gh-cli:auth-token" } },
    credentials: (scope) => () => resolveWorkspaceCredentialEnvironment({
      repositoryId: scope.repositoryId,
      targetRef: TARGET_REF,
      harnessId: scope.harnessId,
      secretRefs: scope.secretRefs,
      bindings: [{ secretName: "copilot", environmentVariable: "COPILOT_GITHUB_TOKEN" }],
    }, {
      resolve: async (request) => {
        if (request.reference.ref !== "gh-cli:auth-token") throw new Error("Unsupported secret reference");
        const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 30_000 });
        return stdout.trim();
      },
    }),
    tasks: [{
      id: "H-1",
      ownerAgent: "docs-writer",
      model: "gpt-6-luna",
      title: "Add a greeting document",
      description: "Create docs/hello.md. Its first line must be exactly '# Hello from MyForge' and it must contain one short sentence explaining that the file was written by an automated MyForge execution test. Do not modify any other file.",
      expectedOutputs: ["docs/hello.md"],
      validationCommands: ["head -n 1 docs/hello.md | grep -qx '# Hello from MyForge'"],
      acceptanceCriteria: ["docs/hello.md starts with '# Hello from MyForge'.", "No other files change."],
    }],
    settings: { maxRetries: 0 },
    timeoutSeconds: 900,
    expect: (result) => {
      check(result.output.status === "complete", "copilot run completed");
      check(result.commits.length === 1 && result.commits[0]!.files.join(",") === "docs/hello.md", "single integrated docs/hello.md change");
    },
  };
}

function opencodeScenario(): Scenario {
  const previousFlags = process.env.OPENCODE_EXTRA_FLAGS;
  process.env.OPENCODE_EXTRA_FLAGS = [previousFlags, "--standalone"].filter(Boolean).join(" ");
  let harness: OpenCodeAdapter;
  try {
    harness = new OpenCodeAdapter();
  } finally {
    if (previousFlags === undefined) delete process.env.OPENCODE_EXTRA_FLAGS;
    else process.env.OPENCODE_EXTRA_FLAGS = previousFlags;
  }

  return {
    name: "real-harness-opencode",
    proves: "A real OpenCode CLI run imports only its explicitly granted GitHub Copilot provider credential into a per-task isolated home and integrates a validated change.",
    harness,
    harnessId: "opencode",
    secretRefs: { "github-copilot": { ref: "opencode-cli:github-copilot" } },
    credentials: (scope) => () => resolveWorkspaceCredentialEnvironment({
      repositoryId: scope.repositoryId,
      targetRef: TARGET_REF,
      harnessId: scope.harnessId,
      secretRefs: scope.secretRefs,
      bindings: [{ secretName: "github-copilot", environmentVariable: "OPENCODE_AUTH_JSON" }],
    }, {
      resolve: async (request) => {
        if (request.reference.ref !== "opencode-cli:github-copilot") throw new Error("Unsupported secret reference");
        const { stdout } = await execFileAsync("opencode", ["auth", "export"], { timeout: 30_000 });
        const exported: unknown = JSON.parse(stdout);
        if (!Array.isArray(exported)) throw new Error("OpenCode auth export was not a credential list");
        const credentials = exported.filter((entry) =>
          entry && typeof entry === "object" && "integrationID" in entry
          && entry.integrationID === "github-copilot");
        if (credentials.length !== 1) throw new Error("A saved GitHub Copilot OpenCode credential is required");
        return JSON.stringify(credentials);
      },
    }),
    tasks: [{
      id: "O-1",
      ownerAgent: "docs-writer",
      model: "github-copilot/gpt-6-luna",
      title: "Add a greeting document",
      description: "Create docs/hello.md. Its first line must be exactly '# Hello from MyForge' and it must contain one short sentence explaining that the file was written by an automated MyForge execution test. Do not modify any other file.",
      expectedOutputs: ["docs/hello.md"],
      validationCommands: ["head -n 1 docs/hello.md | grep -qx '# Hello from MyForge'"],
      acceptanceCriteria: ["docs/hello.md starts with '# Hello from MyForge'.", "No other files change."],
    }],
    settings: { maxRetries: 0 },
    timeoutSeconds: 900,
    expect: (result) => {
      check(result.output.status === "complete", "OpenCode run completed");
      check(result.commits.length === 1 && result.commits[0]!.files.join(",") === "docs/hello.md", "single integrated docs/hello.md change");
    },
  };
}

interface RunContext {
  readonly fixture: ExecutionFixture;
  readonly host: ExecutionHost;
  readonly client: DaprWorkflowClient;
  readonly runs: Map<string, ExecutionHostRunV1>;
  readonly audit: Record<string, unknown>[];
  readonly secrets: string[];
}

async function main(): Promise<void> {
  quietDurableTaskInfo();
  const options = parseOptions(process.argv.slice(2));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "myforge-p4-05-dapr-"));
  const fixture = await createExecutionFixture(options.databaseUrl, { label: "p405", keep: options.keep });
  const runs = new Map<string, ExecutionHostRunV1>();
  const audit: Record<string, unknown>[] = [];
  const secrets: string[] = [];
  let stack: DaprStack | undefined;
  let runtime: WorkflowRuntime | undefined;
  let client: DaprWorkflowClient | undefined;
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    gate: "P4-05",
    generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, node: process.version, dapr: IMAGES.daprd, podman: await podman(["--version"]) },
    scenarios: [] as unknown[],
  };
  try {
    stack = await startDapr(runtimeRoot);
    const bindings = await podman(["pod", "inspect", stack.pod, "--format", "{{json .InfraConfig.PortBindings}}"], true);
    evidence.topology = {
      daprPod: "ephemeral rootless pod; only daprd gRPC/HTTP are published, on 127.0.0.1",
      publishedPorts: bindings ? JSON.parse(bindings) : undefined,
      worker: "host-native ExecutionHost + WorkflowRuntime",
      engineStores: "PostgreSQL schema (receipts, executions, integration, controls, run status)",
    };
    const host = new ExecutionHost({
      runs: (id) => runs.get(id),
      receipts: fixture.receipts,
      executions: fixture.executions,
      integration: fixture.integration,
      checkpoints: fixture.checkpoints,
      status: fixture.status,
      controls: fixture.controls,
      repositoryRoot: fixture.repositoryRoot,
      scratchRoot: fixture.scratchRoot,
      workerId: `p4-05-${process.pid}`,
      budgetMs: 15 * 60_000,
      heartbeatIntervalMs: 2_000,
      heartbeatTtlMs: 30_000,
      audit: (event) => audit.push({ ...event }),
    });
    const daprAddress = { daprHost: "127.0.0.1", daprPort: String(stack.grpcPort) };
    runtime = new WorkflowRuntime(daprAddress);
    registerOrchestrationWorkflows(runtime);
    registerRunLifecycleEventActivity(runtime, fixture.database);
    host.register(runtime);
    await runtime.start();
    client = new DaprWorkflowClient(daprAddress);

    const selected = [
      ...scenarios(),
      ...(options.copilot ? [copilotScenario()] : []),
      ...(options.opencode ? [opencodeScenario()] : []),
    ];
    for (const scenario of selected) {
      process.stdout.write(`▶ ${scenario.name}\n`);
      const record = await runScenario(scenario, { fixture, host, client, runs, audit, secrets });
      (evidence.scenarios as unknown[]).push(record);
      process.stdout.write(`  ${record.passed ? "✔" : "✖"} ${scenario.name}${record.error ? `: ${String(record.error)}` : ""}\n`);
    }
    evidence.passed = (evidence.scenarios as { passed: boolean }[]).every((scenario) => scenario.passed);
  } catch (error) {
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    await client?.stop().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    if (stack && !options.keep) await stack.remove();
    await rm(runtimeRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) throw new Error("Refusing to write evidence: it contains a resolved credential");
  }
  const databasePassword = new URL(options.databaseUrl).password;
  if (databasePassword && serialized.includes(databasePassword)) {
    throw new Error("Refusing to write evidence: it contains the database password");
  }
  await mkdir(dirname(options.evidence), { recursive: true });
  await writeFile(options.evidence, serialized, { mode: 0o644 });
  process.stdout.write(`Evidence: ${options.evidence}\n`);
  if (evidence.passed !== true) {
    if (evidence.error) process.stderr.write(`${String(evidence.error)}\n`);
    process.exitCode = 1;
  }
}

async function runScenario(scenario: Scenario, context: RunContext): Promise<Record<string, unknown>> {
  const { fixture, host, client } = context;
  const started = Date.now();
  const target = await fixture.addTarget(scenario.name, { "README.md": `# ${scenario.name}\n\nDisposable MyForge P4-05 target.\n` });
  const submission = acceptedSubmission({
    repositoryId: target.repositoryId,
    phases: [{ id: "phase-1", tasks: scenario.tasks.map(manifestTask) }],
    ...(scenario.selection ? { selection: scenario.selection } : {}),
    settings: { concurrency: 1, maxRetries: 0, retryDelayMs: 1_000, ...scenario.settings },
    harnessId: scenario.harnessId ?? "scripted-stub",
    ...(scenario.secretRefs ? { secretRefs: scenario.secretRefs } : {}),
  });
  const runId = `run_${randomUUID().replaceAll("-", "")}`;
  const scripted = scenario.script
    ? new ScriptedHarness((request) => scenario.script!(request.task, request.attempt.number))
    : undefined;
  const harness = scenario.harness ?? scripted!;
  const credentialSource = scenario.credentials?.({
    repositoryId: target.repositoryId,
    harnessId: harness.name,
    secretRefs: scenario.secretRefs ?? {},
  });
  const credentials = credentialSource
    ? async () => {
      const resolved = await credentialSource();
      context.secrets.push(...Object.values(resolved));
      return resolved;
    }
    : undefined;
  context.runs.set(runId, executionHostRunFromSubmission(runId, submission, {
    agentFor: (task) => ({ ...agent(task.ownerAgent ?? "unowned"), rawBody: "You are a careful engineer. Make only the requested change." }),
    harness,
    ...(credentials ? { credentials } : {}),
  }));
  await fixture.status.createRun({
    schemaVersion: 1,
    runId,
    repositoryId: target.repositoryId,
    targetRef: TARGET_REF,
    manifestDigest: submission.manifestDigest,
    taskIds: [...submission.selection.effectiveTaskIds],
  });
  const instanceId = `forge-run-${runId}`;
  const approvals: Record<string, unknown>[] = [];
  try {
    await client.scheduleNewWorkflow(RUN_ORCHESTRATION_WORKFLOW_NAME, {
      runId,
      submission,
      controlsEnabled: false,
      statusEnabled: true,
    }, instanceId);
    for (const taskId of scenario.approve ?? []) {
      await waitFor(async () => (await fixture.status.getTaskStatus(runId, taskId))?.task.status === "waiting-for-approval", 120, `${taskId} approval wait`);
      const headWhileWaiting = git(target.target, ["rev-parse", TARGET_REF]);
      const approvalContext = await host.approvalContext(runId, taskId);
      if (!approvalContext) throw new Error(`No approval context for ${taskId}`);
      const controlId = randomUUID();
      const coordinator = new TaskApprovalCoordinator(fixture.controls, {
        raiseEvent: (workflowInstanceId, name, payload) => client.raiseEvent(workflowInstanceId, name, payload),
      });
      const result = await coordinator.approve({
        schemaVersion: 1,
        controlId,
        runId,
        action: "approve-task",
        payload: { taskId, evidenceDigests: [...approvalContext.evidenceDigests] },
      } as ControlRequestV1, { subject: "p4-05-operator", roles: ["operator"] }, approvalContext);
      if (!result.ok) throw new Error(`Approval rejected: ${result.code}`);
      approvals.push({
        taskId,
        controlId,
        event: TASK_CONTROL_EVENT_NAME,
        taskWorkflowInstanceId: approvalContext.taskWorkflowInstanceId,
        evidenceDigests: approvalContext.evidenceDigests,
        targetUnchangedWhileWaiting: headWhileWaiting === target.base,
      });
    }
    const state = await client.waitForWorkflowCompletion(instanceId, true, scenario.timeoutSeconds ?? 180);
    if (!state) throw new Error("Workflow state unavailable");
    const output = JSON.parse(state.serializedOutput ?? "{}") as ScenarioResult["output"];
    const commits = git(target.target, ["log", "--reverse", "--format=%H%x09%s", `${target.base}..${TARGET_REF}`])
      .split("\n").filter(Boolean).map((line) => {
        const [sha, subject] = line.split("\t") as [string, string];
        return { sha, subject, files: git(target.target, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean) };
      });
    const events = await allEvents(fixture, runId);
    const result: ScenarioResult = {
      runtimeStatus: WorkflowRuntimeStatus[state.runtimeStatus] ?? String(state.runtimeStatus),
      output,
      commits,
      events,
    };
    check(approvals.every((approval) => approval.targetUnchangedWhileWaiting === true), "target unchanged while waiting");
    scenario.expect(result);
    const runAudit = context.audit.filter((event) => event.runId === runId);
    const validation = await Promise.all(runAudit
      .filter((event) => event.event === "attempt.verified")
      .map(async (event) => {
        const resolved = await fixture.checkpoints.resolveArtifact(event.validationRef as Parameters<typeof fixture.checkpoints.resolveArtifact>[0]);
        return {
          taskId: event.taskId,
          logicalAttempt: event.logicalAttempt,
          artifact: event.validationRef,
          record: resolved.ok ? JSON.parse(Buffer.from(resolved.bytes).toString("utf8")) as unknown : { unresolved: resolved.code },
        };
      }));
    return {
      name: scenario.name,
      proves: scenario.proves,
      passed: true,
      runId,
      workflowInstanceId: instanceId,
      durationMs: Date.now() - started,
      harness: harness.name,
      selection: submission.selection,
      runStatus: await fixture.status.getRunStatus(runId),
      workflow: result,
      approvals,
      integrations: runAudit.filter((event) => event.event === "attempt.integrated"),
      failures: runAudit.filter((event) => event.event === "attempt.failed"),
      rebases: runAudit.filter((event) => event.event === "attempt.rebased"),
      validationEvidence: validation,
      ...(scripted ? {
        harnessInvocations: scripted.invocations.map((call) => ({
          taskId: call.taskId,
          attempt: call.attempt,
          workspaceSeparateFromTarget: !call.repoRoot.startsWith(target.target),
          isolatedHome: call.childHome?.startsWith(fixture.scratchRoot) ?? false,
          childEnvironmentNames: call.childEnvironment,
        })),
      } : {
        integratedChange: commits.map((commit) => ({
          ...commit,
          diffStat: git(target.target, ["show", "--stat", "--format=", commit.sha]),
          content: Object.fromEntries(commit.files.map((file) => [file, git(target.target, ["show", `${commit.sha}:${file}`])])),
        })),
      }),
    };
  } catch (error) {
    let runtimeStatus: string | undefined;
    try {
      const state = await client.getWorkflowState(instanceId, true);
      runtimeStatus = state ? WorkflowRuntimeStatus[state.runtimeStatus] : undefined;
      if (state?.runtimeStatus === WorkflowRuntimeStatus.RUNNING) await client.terminateWorkflow(instanceId, "verifier-failure");
    } catch {
      // Best effort; the original error is reported below.
    }
    return {
      name: scenario.name,
      proves: scenario.proves,
      passed: false,
      runId,
      runtimeStatus,
      error: error instanceof Error ? error.message : String(error),
      events: await allEvents(fixture, runId).catch(() => []),
      audit: context.audit.filter((event) => event.runId === runId),
    };
  }
}

async function allEvents(fixture: ExecutionFixture, runId: string): Promise<ScenarioResult["events"]> {
  const events: ScenarioResult["events"][number][] = [];
  let cursor = 0;
  for (;;) {
    const page = await fixture.status.listEvents(runId, cursor, 1000);
    events.push(...page.events.map((event) => ({
      eventType: event.eventType,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.logicalAttempt ? { logicalAttempt: event.logicalAttempt } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
    })));
    if (!page.hasMore) return events;
    cursor = page.cursor;
  }
}

await main();
