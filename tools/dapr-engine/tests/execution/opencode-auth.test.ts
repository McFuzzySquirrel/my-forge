import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenCodeAdapter } from "../../execution/harness/opencode-adapter.ts";
import type { TaskAttemptRequest } from "../../execution/types.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

test("OpenCode uses the configured default model when the request has no effective model", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-opencode-model-"));
  const repoRoot = join(root, "repo");
  const bin = join(root, "opencode");
  const argsFile = join(root, "args.json");
  const previousBin = process.env.OPENCODE_BIN;
  const previousFlags = process.env.OPENCODE_EXTRA_FLAGS;
  const previousArgsFile = process.env.OPENCODE_ARGS_FILE;
  try {
    await mkdir(join(repoRoot, "docs"), { recursive: true });
    await writeFile(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
`);
    await chmod(bin, 0o700);
    process.env.OPENCODE_BIN = bin;
    process.env.OPENCODE_EXTRA_FLAGS = "--model opencode/deepseek-v4.1-flash-free";
    process.env.OPENCODE_ARGS_FILE = argsFile;
    const adapter = new OpenCodeAdapter();
    const task = manifestTask({ id: "M-1", ownerAgent: "writer", expectedOutputs: [] });
    const request = {
      agent: agent("writer"),
      task,
      repoRoot,
      attempt: { number: 1, maxRetries: 0, runId: "run-opencode-model" },
      budget: { timeoutMs: 10_000 },
      contextBlock: "",
      requiredCapabilities: ["repository-tools"],
      instructions: "",
    } satisfies TaskAttemptRequest;

    const result = await adapter.invoke(request);
    assert.equal(result.success, true);
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.deepEqual(args.slice(modelIndex, modelIndex + 2), ["--model", "opencode/deepseek-v4.1-flash-free"]);

    const override = await adapter.invoke({ ...request, effectiveModel: "opencode/override-model" });
    assert.equal(override.success, true);
    const overrideArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    const overrideIndex = overrideArgs.indexOf("--model");
    assert.notEqual(overrideIndex, -1);
    assert.deepEqual(overrideArgs.slice(overrideIndex, overrideIndex + 2), ["--model", "opencode/override-model"]);
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousFlags === undefined) delete process.env.OPENCODE_EXTRA_FLAGS;
    else process.env.OPENCODE_EXTRA_FLAGS = previousFlags;
    if (previousArgsFile === undefined) delete process.env.OPENCODE_ARGS_FILE;
    else process.env.OPENCODE_ARGS_FILE = previousArgsFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode imports one granted credential into the task home and does not pass its JSON to the task process", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-opencode-auth-"));
  const repoRoot = join(root, "repo");
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const tempHome = join(root, "tmp");
  const marker = join(root, "auth-imported");
  const bin = join(root, "opencode");
  const previousBin = process.env.OPENCODE_BIN;
  try {
    await Promise.all([
      mkdir(join(repoRoot, "docs"), { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(dataHome, { recursive: true }),
      mkdir(tempHome, { recursive: true }),
    ]);
    await writeFile(bin, `#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "import") {
  const path = args[3];
  const credential = JSON.parse(readFileSync(path, "utf8"));
  if (credential.length !== 1 || (statSync(path).mode & 0o777) !== 0o600) process.exit(12);
  writeFileSync(process.env.VERIFY_AUTH_IMPORT_MARKER, "imported");
} else if (args[0] === "auth" && args[1] === "export") {
  process.stdout.write(JSON.stringify([{ integrationID: "github-copilot", value: { access: "test-secret" } }]));
} else {
  if (process.env.OPENCODE_AUTH_JSON !== undefined) process.exit(13);
  writeFileSync("docs/hello.md", "# Hello from MyForge\\n");
}
`);
    await chmod(bin, 0o700);
    process.env.OPENCODE_BIN = bin;
    const adapter = new OpenCodeAdapter();
    const task = manifestTask({ id: "O-1", ownerAgent: "writer", expectedOutputs: ["docs/hello.md"] });
    const request = {
      agent: agent("writer"),
      task,
      repoRoot,
      attempt: { number: 1, maxRetries: 0, runId: "run-opencode-auth" },
      budget: { timeoutMs: 10_000 },
      contextBlock: "",
      requiredCapabilities: ["repository-tools"],
      instructions: "",
      isolation: {
        environment: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_DATA_HOME: dataHome,
          TMPDIR: tempHome,
          VERIFY_AUTH_IMPORT_MARKER: marker,
          OPENCODE_AUTH_JSON: JSON.stringify([{ integrationID: "github-copilot", value: { access: "test-secret" } }]),
        },
      },
    } satisfies TaskAttemptRequest;
    const result = await adapter.invoke(request);
    assert.equal(result.success, true);
    assert.equal(await readFile(marker, "utf8"), "imported");
    assert.deepEqual(await readdir(tempHome), []);
    assert.deepEqual(result.outputFiles, ["docs/hello.md"]);
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    await rm(root, { recursive: true, force: true });
  }
});
