import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("legacy CLI refuses every command without creating workflow authority", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-retired-engine-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const commands = ["run", "status", "replay", "pause", "stop", "viz", "approve-task"];

  for (const command of commands) {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", entry, command, "--repo", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /workflow-engine CLI is retired/);
    assert.match(result.stderr, /forge-launcher engine-run/);
    assert.equal(existsSync(join(root, "docs", "WORKFLOW-STATE.json")), false);
    assert.equal(existsSync(join(root, "docs", "engine-control.json")), false);
  }
});

test("retired scheduler package does not expose a workflow-engine npm command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal("workflow-engine" in packageJson.scripts, false);
});
