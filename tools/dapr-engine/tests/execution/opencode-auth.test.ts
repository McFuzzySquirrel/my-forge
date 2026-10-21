import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenCodeAdapter } from "../../execution/harness/opencode-adapter.ts";
import type { TaskAttemptRequest } from "../../execution/types.ts";
import { agent, manifestTask } from "../support/execution-fixture.ts";

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
