import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitTaskResult } from "../../execution/task-admission.ts";
import type { ManifestTask, TaskResult } from "../../execution/types.ts";

function task(overrides: Partial<ManifestTask> = {}): ManifestTask {
  return {
    id: "TASK-1",
    title: "Implement task",
    description: "Implement the defined task.",
    dependencies: [],
    expectedOutputs: ["src/result.ts"],
    validationCommands: ["node --version"],
    approvalRequired: false,
    sourceLines: [],
    ...overrides,
  };
}

function result(stdout: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: true,
    outputFiles: [],
    stdout,
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

function report(summary = "Implemented the requested behavior and checked its integration.", unresolved: string[] = []): string {
  return `\`\`\`forge-result\n${JSON.stringify({ summary, unresolved })}\n\`\`\``;
}

function temporaryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "myforge-task-admission-"));
  mkdirSync(join(root, "src"));
  return root;
}

test("admits only a valid handoff with expected outputs and passing mandatory validation", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, "src", "result.ts"), "export const result = true;\n");

  const admitted = await admitTaskResult({
    task: task(),
    result: result(report()),
    repoRoot,
    baseline: null,
    allowNoop: false,
    timeoutMs: 5_000,
  });

  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.deepEqual(admitted.outputFiles, ["src/result.ts"]);
  assert.match(admitted.handoffDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(admitted.gates.map(({ status }) => status), ["passed", "passed", "passed", "passed", "passed"]);
  assert.deepEqual(admitted.validationCommands, ["node --version"]);
});

test("expected outputs remain mandatory even when no-op is explicitly allowed", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const admitted = await admitTaskResult({
    task: task(),
    result: result(report()),
    repoRoot,
    baseline: null,
    allowNoop: true,
    timeoutMs: 5_000,
  });

  assert.equal(admitted.ok, false);
  if (admitted.ok) return;
  assert.equal(admitted.failureCode, "expected-outputs-missing");
  assert.equal(admitted.gates.find(({ gate }) => gate === "outputs")?.status, "failed");
});

test("rejects a hollow structured outcome when no outputs or substantive changes are produced", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const admitted = await admitTaskResult({
    task: task({ expectedOutputs: [], validationCommands: [] }),
    result: result(report("Done")),
    repoRoot,
    baseline: null,
    allowNoop: false,
    timeoutMs: 5_000,
  });

  assert.equal(admitted.ok, false);
  if (admitted.ok) return;
  assert.equal(admitted.failureCode, "no-op");
  assert.equal(admitted.gates.find(({ gate }) => gate === "outputs")?.status, "failed");
});

test("requires a structured outcome and rejects unresolved blockers", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, "src", "result.ts"), "export const result = true;\n");

  const missing = await admitTaskResult({
    task: task(),
    result: result("Finished."),
    repoRoot,
    baseline: null,
    allowNoop: false,
    timeoutMs: 5_000,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.failureCode, "invalid-handoff");

  const unresolved = await admitTaskResult({
    task: task(),
    result: result(report("Implemented the behavior, but a required integration remains blocked.", ["Live integration check"])),
    repoRoot,
    baseline: null,
    allowNoop: false,
    timeoutMs: 5_000,
  });
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) {
    assert.equal(unresolved.failureCode, "unresolved-requirements");
    assert.equal(unresolved.gates.find(({ gate }) => gate === "requirements")?.status, "failed");
  }
});

test("runs declared validation commands regardless of legacy opt-in behavior", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, "src", "result.ts"), "export const result = true;\n");

  const admitted = await admitTaskResult({
    task: task({ validationCommands: ['node -e "process.exit(1)"'] }),
    result: result(report()),
    repoRoot,
    baseline: null,
    allowNoop: true,
    timeoutMs: 5_000,
  });

  assert.equal(admitted.ok, false);
  if (admitted.ok) return;
  assert.equal(admitted.failureCode, "validation-failed");
  assert.equal(admitted.gates.at(-1)?.gate, "validation");
  assert.equal(admitted.gates.at(-1)?.status, "failed");
});

test("explicit no-op policy does not disable structured outcome or requirement gates", async (t) => {
  const repoRoot = temporaryRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const admitted = await admitTaskResult({
    task: task({ expectedOutputs: [], validationCommands: [] }),
    result: result(report("No code changes were required; the requested analysis is complete.")),
    repoRoot,
    baseline: null,
    allowNoop: true,
    timeoutMs: 5_000,
  });

  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.deepEqual(admitted.outputFiles, []);
  assert.equal(admitted.gates.find(({ gate }) => gate === "outputs")?.status, "passed");
});
