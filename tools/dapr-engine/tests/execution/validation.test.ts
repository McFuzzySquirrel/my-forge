import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runValidationCommands } from "../../execution/validation.ts";

test("installs missing project dependencies before validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const marker = join(root, "npm-ci-ran");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(bin, "npm"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
  await chmod(join(bin, "npm"), 0o755);

  const result = await runValidationCommands({
    task: { validationCommands: [process.execPath + " -e \"process.exit(0)\""] },
    workspacePath: root,
    timeoutMs: 10_000,
    environment: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    installDependencies: true,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.results.length, 1);
  assert.equal(await readFile(marker, "utf8"), "");
});

test("returns bounded evidence when a validation command fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myforge-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runValidationCommands({
    task: { validationCommands: [`${process.execPath} -e "process.stderr.write('boom'); process.exit(3)"`] },
    workspacePath: root,
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /exit 3/);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.status, 3);
  assert.match(result.results[0]?.stderr ?? "", /boom/);
});
