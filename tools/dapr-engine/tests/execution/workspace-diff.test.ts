import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { sha256Digest } from "../../contract/v1/index.ts";
import {
  applyWorkspaceDelta,
  captureWorkspaceDelta,
  DEFAULT_MAX_WORKSPACE_DELTA_BYTES,
} from "../../execution/workspace-diff.ts";
import type { HarnessRunnerWorkspaceDeltaV1 } from "../../execution/runner-contract.ts";

function git(cwd: string, args: readonly string[]): string {
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

async function createWorkspacePair(t: test.TestContext): Promise<{
  baseRevision: string;
  source: string;
  target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "myforge-workspace-diff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source, { recursive: true });
  git(root, ["init", "--quiet", "--initial-branch=main", source]);
  git(source, ["config", "user.name", "MyForge test"]);
  git(source, ["config", "user.email", "myforge-test@example.invalid"]);
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(source, "remove.txt"), "remove me\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(source, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--quiet", "--no-hardlinks", source, target]);
  git(target, ["checkout", "--quiet", "--detach", baseRevision]);
  return { baseRevision, source, target };
}

test("workspace diff round-trips modifications, deletions, untracked files, and binary content", async (t) => {
  const { baseRevision, source, target } = await createWorkspacePair(t);
  await writeFile(join(source, "src", "index.ts"), "export const value = 2;\n");
  await rm(join(source, "remove.txt"));
  await mkdir(join(source, "assets"), { recursive: true });
  const binary = Buffer.from([0, 1, 2, 255]);
  await writeFile(join(source, "assets", "payload.bin"), binary);

  const delta = await captureWorkspaceDelta(source, baseRevision);
  assert.equal(delta.baseRevision, baseRevision);
  assert.equal(delta.format, "git-binary-diff-v1");
  assert.equal(sha256Digest(Buffer.from(delta.contentBase64, "base64")), delta.digest);

  await applyWorkspaceDelta(target, delta);

  assert.equal(await readFile(join(target, "src", "index.ts"), "utf8"), "export const value = 2;\n");
  await assert.rejects(readFile(join(target, "remove.txt")));
  assert.deepEqual(await readFile(join(target, "assets", "payload.bin")), binary);
  assert.equal((await captureWorkspaceDelta(target, baseRevision)).contentBase64, delta.contentBase64);
});

test("workspace delta capture requires the accepted base and enforces its size limit", async (t) => {
  const { baseRevision, source } = await createWorkspacePair(t);
  await writeFile(join(source, "src", "index.ts"), "x".repeat(512));
  await assert.rejects(captureWorkspaceDelta(source, "f".repeat(40)), /does not match the accepted base revision/);
  await assert.rejects(captureWorkspaceDelta(source, baseRevision, { maxBytes: 10 }), /exceeds 10 bytes/);
});

test("workspace delta application rejects wrong bases, invalid digests, and oversized payloads", async (t) => {
  const { baseRevision, target } = await createWorkspacePair(t);
  const delta = await captureWorkspaceDelta(target, baseRevision);
  await assert.rejects(applyWorkspaceDelta(target, {
    ...delta,
    baseRevision: "f".repeat(40),
  }), /does not match the accepted base revision/);
  await assert.rejects(applyWorkspaceDelta(target, {
    ...delta,
    digest: `sha256:${"f".repeat(64)}`,
  }), /digest does not match its content/);
  await assert.rejects(applyWorkspaceDelta(target, delta, { maxBytes: -1 }), /non-negative safe integer/);
});

test("workspace delta cannot apply a path outside the worktree", async (t) => {
  const { baseRevision, target } = await createWorkspacePair(t);
  const patch = [
    "diff --git a/../escaped.txt b/../escaped.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/../escaped.txt",
    "@@ -0,0 +1 @@",
    "+not allowed",
    "",
  ].join("\n");
  const bytes = Buffer.from(patch);
  const delta: HarnessRunnerWorkspaceDeltaV1 = {
    format: "git-binary-diff-v1",
    baseRevision,
    digest: sha256Digest(bytes),
    contentBase64: bytes.toString("base64"),
  };

  await assert.rejects(applyWorkspaceDelta(target, delta), /invalid path|Command failed/);
  await assert.rejects(readFile(join(dirname(target), "escaped.txt")));
});

test("workspace delta size default is bounded", () => {
  assert.equal(DEFAULT_MAX_WORKSPACE_DELTA_BYTES, 16 * 1024 * 1024);
});
