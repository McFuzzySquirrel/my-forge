import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const stageScript = fileURLToPath(new URL("./stage-resources.mjs", import.meta.url));

test("launcher resources package the execution service without the retired scheduler", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-stage-resources-"));
  const resources = join(root, "package-resources");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "templates", "skills", "sample-skill"), { recursive: true });
  writeFileSync(join(root, "templates", "skills", "sample-skill", "SKILL.md"), "sample\n");
  mkdirSync(join(root, "tools", "dapr-engine", "execution", "node_modules"), { recursive: true });
  mkdirSync(join(root, "tools", "dapr-engine", "deploy", "components"), { recursive: true });
  mkdirSync(join(root, "tools", "dapr-engine", "scripts"), { recursive: true });
  for (const directory of ["contract", "orchestration", "service", "storage"]) {
    mkdirSync(join(root, "tools", "dapr-engine", directory), { recursive: true });
  }
  writeFileSync(join(root, "docs", "prompt-playbook.md"), "playbook\n");
  writeFileSync(join(root, "tools", "dapr-engine", "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "tools", "dapr-engine", "scripts", "host-runner.ts"), "export {};\n");
  writeFileSync(join(root, "tools", "dapr-engine", "execution", "index.ts"), "export {};\n");
  writeFileSync(join(root, "tools", "dapr-engine", "execution", "node_modules", "ignored.js"), "ignored\n");
  writeFileSync(join(root, "tools", "dapr-engine", "workflow.ts"), "service\n");
  writeFileSync(join(root, "tools", "dapr-engine", "service", "main.ts"),
    'await Promise.resolve();\nconsole.log("service entry ready");\n');
  writeFileSync(join(root, "tools", "dapr-engine", "storage", "migration.sql"), "migration\n");
  writeFileSync(join(root, "tools", "dapr-engine", "deploy", "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "tools", "dapr-engine", "deploy", "components", "state.yaml"), "kind: Component\n");

  execFileSync(process.execPath, [stageScript, root, resources], { stdio: "pipe" });

  assert.ok(!existsSync(join(resources, "templates", "skills", "forge-workflow-engine")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "execution", "index.ts")));
  assert.ok(!existsSync(join(resources, "tools", "dapr-engine", "execution", "node_modules")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "service", "main.ts")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "storage", "migration.sql")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "scripts", "host-runner.ts")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "node_modules")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "deploy", "compose.yaml")));
  assert.ok(existsSync(join(resources, "tools", "dapr-engine", "deploy", "components", "state.yaml")));
  assert.ok(!existsSync(join(resources, "tools", "dapr-engine", "workflow.ts")));

  const output = execFileSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    join(resources, "tools", "dapr-engine", "service", "main.ts"),
  ], { cwd: join(resources, "tools", "dapr-engine"), encoding: "utf8" });
  assert.equal(output.trim(), "service entry ready");
});
