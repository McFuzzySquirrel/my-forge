import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBranchRefUpdater } from "../../storage/index.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("Git branch integration uses an atomic expected-head update", async () => {
  const root = mkdtempSync(join(tmpdir(), "myforge-git-fence-"));
  try {
    git(root, ["init", "--quiet", "--initial-branch=main"]);
    git(root, ["config", "user.name", "MyForge tests"]);
    git(root, ["config", "user.email", "myforge-tests@example.invalid"]);
    writeFileSync(join(root, "change.txt"), "base\n");
    git(root, ["add", "change.txt"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    const expectedHead = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, "change.txt"), "integrated\n");
    git(root, ["commit", "--quiet", "-am", "integrated"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/heads/main", expectedHead]);

    const updater = new GitBranchRefUpdater();
    assert.equal(await updater.update(root, "refs/heads/main", commitSha, expectedHead), true);
    assert.equal(git(root, ["rev-parse", "refs/heads/main"]), commitSha);

    assert.equal(await updater.update(root, "refs/heads/main", expectedHead, expectedHead), false);
    assert.equal(git(root, ["rev-parse", "refs/heads/main"]), commitSha);

    assert.deepEqual(await updater.readCommit(root, commitSha), {
      tree: git(root, ["rev-parse", `${commitSha}^{tree}`]),
      parents: [expectedHead],
    });
    assert.equal(await updater.readCommit(root, "f".repeat(40)), undefined);
    assert.equal(await updater.contains(root, "refs/heads/main", expectedHead), true);
    assert.equal(await updater.contains(root, "refs/heads/main", commitSha), true);
    git(root, ["update-ref", "refs/heads/main", expectedHead]);
    assert.equal(await updater.contains(root, "refs/heads/main", commitSha), false);
    assert.equal(await updater.contains(root, "refs/heads/missing", expectedHead), false);
    assert.equal(await updater.contains(root, "refs/heads/main", "f".repeat(40)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
