import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFeatureFixture } from "./feature-fixture.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

function tmpRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fl-run-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFeatureFixture(root);
  return root;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile("node", ["--import", "tsx", CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) {
        resolve({ code: (err as { code?: number }).code ?? 1, out: stdout + stderr });
        return;
      }
      resolve({ code: 0, out: stdout + stderr });
    });
  });
}

// OpenCode v2 removed `run --dir` and `run --attach` (ADR-058), so the engine's
// keep-alive and attach flags are retired. The engine no longer manages a warm
// `opencode serve`; each `opencode run` connects to OpenCode's own background
// service. These tests pin the retirement: the flags are rejected rather than
// silently forwarded, since OpenCode v2 hard-fails on an unknown flag.
test("run rejects the retired --keep-alive / --attach flags", async () => {
  for (const flag of ["--keep-alive", "--keep-alive-port", "--no-keep-alive", "--attach"]) {
    const repo = tmpRepo();
    const args = flag === "--keep-alive-port" || flag === "--attach"
      ? ["run", "--repo", repo, "--harness", "opencode", flag, "4096", "--yes", "--dry-run"]
      : ["run", "--repo", repo, "--harness", "opencode", flag, "--yes", "--dry-run"];
    const { code, out } = await runCli(args);
    assert.notEqual(code, 0, `${flag} was accepted but is retired: ${out}`);
    // The rejection is explicit, so the message may name the flag; what must
    // not happen is a dry-run command that still carries it.
    assert.ok(!/run[^\n]*--keep-alive/.test(out), `${flag} was forwarded: ${out}`);
    assert.ok(!/run[^\n]*--attach/.test(out), `${flag} was forwarded: ${out}`);
  }
});

test("run, pause, stop, and dry-run require service registration and never fall back", async () => {
  const repo = tmpRepo();
  const cases = [
    ["run", "--repo", repo, "--harness", "opencode", "--yes", "--dry-run"],
    ["run", "--repo", repo, "--pause", "--dry-run"],
    ["run", "--repo", repo, "--stop", "--dry-run"],
  ];
  for (const args of cases) {
    const { code, out } = await runCli(args);
    assert.notEqual(code, 0, out);
    assert.match(out, /not registered with the local execution service/);
    assert.match(out, /runtime repo add/);
    assert.doesNotMatch(out, /workflow-engine -- (run|pause|stop)/);
  }
});
