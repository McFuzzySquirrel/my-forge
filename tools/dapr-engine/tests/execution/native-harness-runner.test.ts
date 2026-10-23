import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyWorkspaceDelta } from "../../execution/workspace-diff.ts";
import { NativeHarnessRunner } from "../../execution/native-harness-runner.ts";
import { parseHarnessRunnerResult, type HarnessRunnerRequestV1 } from "../../execution/runner-contract.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";
import { ScriptedHarness } from "../support/scripted-harness.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

async function makeRepository(root: string): Promise<{ path: string; baseRevision: string }> {
  const path = join(root, "source");
  await mkdir(path);
  await git(path, "init", "--quiet", "--initial-branch=main");
  await git(path, "config", "user.name", "MyForge test");
  await git(path, "config", "user.email", "myforge-test@example.invalid");
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, "add", "--all");
  await git(path, "commit", "--quiet", "-m", "base");
  const baseRevision = await git(path, "rev-parse", "HEAD");
  return { path, baseRevision };
}

function request(repositoryId: string, baseRevision: string): HarnessRunnerRequestV1 {
  const task = manifestTask({
    id: "T1",
    ownerAgent: "builder",
    expectedOutputs: ["result.txt"],
  });
  return {
    schemaVersion: 1,
    identity: {
      runId: `run_${"a".repeat(32)}`,
      taskId: task.id,
      manifestDigest: `sha256:${"1".repeat(64)}`,
      logicalAttempt: 1,
      operationId: "11111111-1111-4111-8111-111111111111",
    },
    repositoryId,
    baseRevision,
    harness: "scripted-stub",
    agent: agent("builder"),
    task,
    contextBlock: "",
    requiredCapabilities: ["repository-tools"],
    timeoutMs: 10_000,
    instructions: "Create result.txt.",
  };
}

describe("NativeHarnessRunner", () => {
  it("runs in a registered repository clone, preserves CLI auth and removes runtime secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "myforge-native-runner-"));
    roots.push(root);
    const repository = await makeRepository(root);
    const home = join(root, "operator-home");
    await mkdir(home);
    await writeFile(join(home, "cli-auth.json"), "normal user authentication");
    const harness = new ScriptedHarness(() => ({ files: { "result.txt": "completed\n" } }));
    const runner = new NativeHarnessRunner({
      workspacesRoot: join(root, "workspaces"),
      repositoryRoot: (id) => id === "repo_test" ? repository.path : undefined,
      harnesses: new Map([[harness.name, harness]]),
      inheritedEnvironment: {
        PATH: process.env.PATH,
        HOME: home,
        OPENAI_API_KEY: "provider-auth",
        MYFORGE_API_TOKEN: "runtime-api-token",
        MYFORGE_HOST_RUNNER_API_TOKEN: "host-runner-api-token",
        MYFORGE_HOST_RUNNER_CAPABILITY: "runner-capability",
        DAPR_API_TOKEN: "dapr-token",
        APP_DB_PASSWORD: "database-password",
        POSTGRES_PASSWORD: "postgres-password",
      },
    });

    const result = await runner.run(request("repo_test", repository.baseRevision));
    const parsed = parseHarnessRunnerResult(
      request("repo_test", repository.baseRevision),
      result,
      1024 * 1024,
    );
    const invocation = harness.invocations[0];
    assert.ok(invocation);
    assert.equal(invocation.childHome, home);
    assert.ok(invocation.childEnvironment.includes("OPENAI_API_KEY"));
    for (const secret of [
      "MYFORGE_API_TOKEN",
      "MYFORGE_HOST_RUNNER_API_TOKEN",
      "MYFORGE_HOST_RUNNER_CAPABILITY",
      "DAPR_API_TOKEN",
      "APP_DB_PASSWORD",
      "POSTGRES_PASSWORD",
    ]) {
      assert.ok(!invocation.childEnvironment.includes(secret), `${secret} must not reach the harness`);
    }
    assert.equal(invocation.taskId, "T1");
    assert.equal(invocation.repoRoot.startsWith(join(root, "workspaces", "attempt-")), true);
    assert.equal(parsed.result.success, true);
    assert.match(Buffer.from(parsed.workspaceDelta.contentBase64, "base64").toString(), /result\.txt/);
    await assert.rejects(readFile(invocation.repoRoot), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(root, "workspaces")), []);

    const target = join(root, "target");
    await git(root, "clone", "--quiet", repository.path, target);
    await applyWorkspaceDelta(target, parsed.workspaceDelta);
    assert.equal(await readFile(join(target, "result.txt"), "utf8"), "completed\n");
  });

  it("rejects invalid repository identifiers before resolving a host path", async () => {
    const root = await mkdtemp(join(tmpdir(), "myforge-native-runner-"));
    roots.push(root);
    const harness = new ScriptedHarness(() => ({}));
    let resolved = false;
    const runner = new NativeHarnessRunner({
      workspacesRoot: join(root, "workspaces"),
      repositoryRoot: () => {
        resolved = true;
        return root;
      },
      harnesses: new Map([[harness.name, harness]]),
    });

    await assert.rejects(
      runner.run(request("../outside", "a".repeat(40))),
      /Host-runner request has an invalid schema/,
    );
    assert.equal(resolved, false);
    assert.equal(harness.invocations.length, 0);
  });
});
