import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secureRegisteredGitMetadata } from "../../service/repository-git-boundary.ts";

test("fails closed when a mounted repository does not contain a .git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-git-boundary-"));
  try {
    await mkdir(join(root, "repo"));
    await assert.rejects(secureRegisteredGitMetadata(root), /has no mounted \.git directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a mounted .git path is a symlink", {
  skip: process.platform === "win32" ? "requires native symlink support" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-git-boundary-"));
  try {
    const repository = join(root, "repo");
    const target = join(root, "target");
    await mkdir(repository);
    await mkdir(target);
    await writeFile(join(target, "HEAD"), "ref: refs/heads/main\n");
    await symlink(target, join(repository, ".git"));
    await assert.rejects(secureRegisteredGitMetadata(root), /has no mounted \.git directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sets every mounted .git root owner-only and verifies task-UID denial", {
  skip: process.getuid?.() !== 0 ? "requires root to probe a different task UID" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "myforge-git-boundary-"));
  try {
    const firstGit = join(root, "first", ".git");
    const secondGit = join(root, "second", ".git");
    for (const gitRoot of [firstGit, secondGit]) {
      await mkdir(gitRoot, { recursive: true, mode: 0o755 });
      await writeFile(join(gitRoot, "HEAD"), "ref: refs/heads/main\n");
      await chmod(gitRoot, 0o755);
    }

    await secureRegisteredGitMetadata(root);

    for (const gitRoot of [firstGit, secondGit]) {
      const { mode } = await stat(gitRoot);
      assert.equal(mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
