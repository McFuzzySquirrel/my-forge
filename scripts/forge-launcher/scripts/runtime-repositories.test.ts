import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultRepositoryId,
  findRegisteredRepository,
  listRegisteredRepositories,
  registerRepository,
  renderRepositoryOverride,
  unregisterRepository,
  validateRepositoryMountPath,
  writeRepositoryOverride,
} from "./runtime-repositories.ts";

async function fixture(t: test.TestContext): Promise<{ dataDir: string; root: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "forge-repos-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  return { dataDir, root };
}

async function gitRepo(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await mkdir(path.join(repo, ".git"), { recursive: true });
  return repo;
}

test("repositories register by real path with stable IDs and reject conflicts", async (t) => {
  const { dataDir, root } = await fixture(t);
  const app = await gitRepo(root, "My App");
  const registered = await registerRepository(dataDir, app);
  assert.deepEqual(registered, { id: "my-app", path: app });
  assert.deepEqual(await registerRepository(dataDir, app), registered, "re-registering without --id is idempotent");
  await assert.rejects(registerRepository(dataDir, app, "other"), /already registered as 'my-app'/);

  const second = await gitRepo(path.join(root, "nested"), "my-app");
  await assert.rejects(registerRepository(dataDir, second), /already registered for another path/);
  assert.equal((await registerRepository(dataDir, second, "my-app-2")).id, "my-app-2");
  await assert.rejects(registerRepository(dataDir, second, "Bad ID"), /Repository IDs must match/);

  assert.deepEqual((await listRegisteredRepositories(dataDir)).map((entry) => entry.id), ["my-app", "my-app-2"]);
  assert.equal((await findRegisteredRepository(dataDir, path.join(app, ".")))?.id, "my-app");
  assert.equal(await unregisterRepository(dataDir, "my-app"), true);
  assert.equal(await unregisterRepository(dataDir, "my-app"), false);
  assert.equal(await findRegisteredRepository(dataDir, app), undefined);
});

test("repositories without a .git directory cannot be registered", async (t) => {
  const { dataDir, root } = await fixture(t);
  const plain = path.join(root, "plain");
  await mkdir(plain);
  await assert.rejects(registerRepository(dataDir, plain), /not a Git repository root/);
  const worktree = path.join(root, "worktree");
  await mkdir(worktree);
  await writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
  await assert.rejects(registerRepository(dataDir, worktree), /linked worktrees and submodules/);
  const comma = await gitRepo(root, "a,b");
  await assert.rejects(registerRepository(dataDir, comma, "comma"), /cannot be mounted/);
});

test("repository mount paths allow Windows drive prefixes but reject mount delimiters", () => {
  assert.doesNotThrow(() => validateRepositoryMountPath("C:\\Users\\operator\\My App", "win32"));
  assert.doesNotThrow(() => validateRepositoryMountPath("D:/repos/My App", "win32"));
  assert.doesNotThrow(() => validateRepositoryMountPath("\\\\server\\share\\app", "win32"));
  assert.doesNotThrow(() => validateRepositoryMountPath("/work/My App", "linux"));
  for (const platform of ["linux", "win32"] as const) {
    for (const invalid of ["/work/a:b", "/work/a,b", "/work/a\nb", "/work/a\rb", "C:\\repos\\a:b"]) {
      assert.throws(() => validateRepositoryMountPath(invalid, platform), /cannot be mounted/);
    }
  }
});

test("the compose override mounts only registered .git directories", async (t) => {
  const { dataDir, root } = await fixture(t);
  assert.equal(await writeRepositoryOverride(dataDir), undefined);
  const app = await gitRepo(root, "app");
  await registerRepository(dataDir, app);
  const file = await writeRepositoryOverride(dataDir);
  assert.ok(file);
  const text = await readFile(file, "utf8");
  assert.equal(text, renderRepositoryOverride([{ id: "app", path: app }]));
  assert.ok(text.includes(`- ${JSON.stringify(`${path.join(app, ".git")}:/repositories/app/.git:rw,z`)}`));
  assert.doesNotMatch(text, /sock|\$HOME|~/);

  await unregisterRepository(dataDir, "app");
  assert.equal(await writeRepositoryOverride(dataDir), undefined);
  await assert.rejects(readFile(file), /ENOENT/);
});

test("default repository IDs are slugs of the directory name", () => {
  assert.equal(defaultRepositoryId("/work/My.Project"), "my-project");
  assert.equal(defaultRepositoryId("/work/__x"), "x");
  assert.equal(defaultRepositoryId("/work/...."), "repository");
});
