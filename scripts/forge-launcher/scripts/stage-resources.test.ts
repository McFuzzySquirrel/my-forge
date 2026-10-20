import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const stageScript = fileURLToPath(new URL("./stage-resources.mjs", import.meta.url));

test("launcher resources package the execution service and its dependencies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-stage-resources-"));
  const resources = join(root, "package-resources");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "templates", "skills", "forge-workflow-engine"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "tools", "dapr-engine", "execution", "node_modules"), { recursive: true });
  mkdirSync(join(root, "tools", "dapr-engine", "deploy", "components"), { recursive: true });
  for (const directory of ["contract", "orchestration", "service", "storage"]) {
    mkdirSync(join(root, "tools", "dapr-engine", directory), { recursive: true });
  }
  writeFileSync(join(root, "templates", "skills", "forge-workflow-engine", "SKILL.md"), "engine skill\n");
  writeFileSync(join(root, "docs", "prompt-playbook.md"), "playbook\n");
  writeFileSync(join(root, "tools", "dapr-engine", "execution", "index.ts"), "export {};\n");
  writeFileSync(join(root, "tools", "dapr-engine", "execution", "node_modules", "ignored.js"), "ignored\n");
  writeFileSync(join(root, "tools", "dapr-engine", "workflow.ts"), "service\n");
  writeFileSync(join(root, "tools", "dapr-engine", "service", "main.ts"), "service entry\n");
  writeFileSync(join(root, "tools", "dapr-engine", "storage", "migration.sql"), "migration\n");
  writeFileSync(join(root, "tools", "dapr-engine", "deploy", "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "tools", "dapr-engine", "deploy", "components", "state.yaml"), "kind: Component\n");

  execFileSync(process.execPath, [stageScript, root, resources], { stdio: "pipe" });

  assert.ok(existsSync(join(resources, "templates", "skills", "forge-workflow-engine", "SKILL.md")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "execution", "index.ts")));
  assert.ok(!existsSync(join(resources, "tools", "dapr-engine", "execution", "node_modules")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "service", "main.ts")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "storage", "migration.sql")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "node_modules")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "deploy", "compose.yaml")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "deploy", "components", "state.yaml")));
  assert.ok(!existsSync(join(resources, "tools", "dapr-engine", "workflow.ts")));
});
