import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { commitCounts, createFixtureRepo } from "./fixture.ts";
import { allEvents, connect, runState, submit, taskStatus, waitForApi, waitForTaskStatus, waitForTerminal, whenReachable } from "./service.ts";
import {
  assert,
  containerName,
  launcher,
  must,
  podman,
  REPO_ROOT,
  requireLauncher,
  run,
  useLauncherFrom,
  waitFor,
  type Isolation,
  type Report,
} from "./support.ts";

/** The release immediately before P6-03 (P6-02); its schema stops at migration 6. */
export const PREVIOUS_RELEASE = "8be6cb0";
const RETRY_DELAY_MS = 90_000;

/** A detached worktree of the previous release with launcher dependencies installed. */
function previousRelease(root: string): string {
  const checkout = path.join(root, `release-${PREVIOUS_RELEASE}`);
  if (!existsSync(path.join(checkout, "scripts", "forge-launcher", "node_modules", "tsx"))) {
    run("git", ["worktree", "remove", "--force", checkout], REPO_ROOT);
    must("git", ["worktree", "add", "--detach", checkout, PREVIOUS_RELEASE], REPO_ROOT);
    must("npm", ["ci", "--no-audit", "--no-fund", "--silent"], path.join(checkout, "scripts", "forge-launcher"));
  }
  return checkout;
}

export function removePreviousRelease(root: string): void {
  run("git", ["worktree", "remove", "--force", path.join(root, `release-${PREVIOUS_RELEASE}`)], REPO_ROOT);
}

function failOnce(nonce: string, taskId: string): string {
  const marker = `/var/lib/myforge/qual-markers/${nonce}-${taskId}`;
  return `test -f ${marker} || { mkdir -p /var/lib/myforge/qual-markers && touch ${marker} && exit 1; }`;
}

function exactlyOnce(repoRoot: string, runId: string, taskIds: readonly string[]): Record<string, number> {
  const counts = commitCounts(repoRoot, runId);
  for (const taskId of taskIds) assert(counts[taskId] === 1, `expected exactly one ${taskId} commit, found ${counts[taskId] ?? 0}`);
  assert(Object.keys(counts).length === taskIds.length, `unexpected integration commits: ${JSON.stringify(counts)}`);
  return counts;
}

function psql(isolation: Isolation, sql: string): string {
  return podman(["exec", containerName(isolation, "postgres"), "psql", "-U", "postgres", "-d", "myforge_app", "-At", "-c", sql]);
}

function output(result: { readonly stdout: string; readonly stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * P6-03: upgrade and rollback across releases. The previous release creates
 * in-flight durable work; the current release must migrate in place and
 * finish it exactly once. Rolling back must be refused against the migrated
 * schema and succeed by restoring the pre-upgrade backup.
 */
export async function runUpgradeSuite(report: Report, isolation: Isolation): Promise<void> {
  const nonce = randomBytes(3).toString("hex");
  const previous = previousRelease(isolation.root);
  const current = REPO_ROOT;
  const repo = (name: string, tasks: Parameters<typeof createFixtureRepo>[2]) =>
    createFixtureRepo(isolation.root, `upgrade-${name}-${nonce}`, tasks);

  await report.scenario("U01", "In-place upgrade finishes an approval wait and a pending retry timer exactly once", async (details) => {
    useLauncherFrom(previous);
    await launcher(["runtime", "reset", "--confirm"]);
    const approvalRepo = repo("approval", [{ id: "T1" }, { id: "R1", humanReview: true, dependencies: ["T1"] }, { id: "T2", dependencies: ["R1"] }]);
    const timerRepo = repo("timer", [{ id: "T1", validation: [failOnce(nonce, "T1")] }]);
    const freshRepo = repo("fresh", [{ id: "T1" }]);
    for (const repoRoot of [approvalRepo, timerRepo, freshRepo]) await requireLauncher(["runtime", "repo", "add", repoRoot]);
    await requireLauncher(["runtime", "start"]);
    let client = await connect();
    await waitForApi(client);
    details.previousSchema = psql(isolation, "SELECT max(version) FROM forge_schema_migrations");
    const approvalRun = (await submit(client, approvalRepo)).runId;
    const timerRun = (await submit(client, timerRepo, { maxRetries: 2, retryDelayMs: RETRY_DELAY_MS })).runId;
    details.runs = { approvalRun, timerRun };
    await waitForTaskStatus(client, approvalRun, "R1", ["waiting-for-approval"], 180_000);
    await waitFor("timer run attempt 1 to fail", async () =>
      (await allEvents(client, timerRun)).some((event) => event.eventType === "attempt.failed") || undefined, 180_000);

    useLauncherFrom(current);
    const upgradeStarted = Date.now();
    await requireLauncher(["runtime", "stop"]);
    await requireLauncher(["runtime", "start"]);
    client = await connect();
    await waitForApi(client);
    details.upgradeMs = Date.now() - upgradeStarted;
    details.currentSchema = psql(isolation, "SELECT max(version) FROM forge_schema_migrations");
    assert(Number(details.currentSchema) === Number(details.previousSchema) + 1, `schema ${details.previousSchema} -> ${details.currentSchema}`);
    details.definitionVersions = psql(isolation, "SELECT DISTINCT definition_version FROM forge_run_statuses");
    assert(details.definitionVersions === "1", `pre-upgrade runs carry definition ${details.definitionVersions}`);

    assert(taskStatus(await runState(client, approvalRun), "R1") === "waiting-for-approval", "approval wait lost across upgrade");
    await whenReachable(() => client.control(approvalRun, "approve-task", { taskId: "R1" }));
    const approvalFinal = await waitForTerminal(client, approvalRun, 180_000);
    assert(approvalFinal.status === "complete", `approval run ended ${approvalFinal.status}`);
    details.approvalCommits = exactlyOnce(approvalRepo, approvalRun, ["T1", "T2"]);
    const timerFinal = await waitForTerminal(client, timerRun, RETRY_DELAY_MS + 180_000);
    assert(timerFinal.status === "complete", `timer run ended ${timerFinal.status}`);
    details.timerCommits = exactlyOnce(timerRepo, timerRun, ["T1"]);
    const fresh = (await submit(client, freshRepo)).runId;
    assert((await waitForTerminal(client, fresh, 180_000)).status === "complete", "a run submitted after upgrade did not complete");
    details.freshRunDefinition = psql(isolation, `SELECT definition_version FROM forge_run_statuses WHERE run_id = '${fresh}'`);
  });

  await report.scenario("U02", "Rollback refuses the migrated schema and restores the pre-upgrade backup", async (details) => {
    useLauncherFrom(previous);
    await launcher(["runtime", "reset", "--confirm"]);
    const approvalRepo = repo("rollback", [{ id: "T1" }, { id: "R1", humanReview: true, dependencies: ["T1"] }, { id: "T2", dependencies: ["R1"] }]);
    await requireLauncher(["runtime", "repo", "add", approvalRepo]);
    await requireLauncher(["runtime", "start"]);
    let client = await connect();
    await waitForApi(client);
    const runId = (await submit(client, approvalRepo)).runId;
    details.run = runId;
    await waitForTaskStatus(client, runId, "R1", ["waiting-for-approval"], 180_000);
    const backup = path.join(isolation.root, "backups", `pre-upgrade-${nonce}`);
    mkdirSync(path.dirname(backup), { recursive: true });
    await requireLauncher(["runtime", "backup", "--output", backup]);
    details.backup = backup;

    useLauncherFrom(current);
    await requireLauncher(["runtime", "stop"]);
    await requireLauncher(["runtime", "start"]);
    await waitForApi(await connect());

    useLauncherFrom(previous);
    await requireLauncher(["runtime", "stop"]);
    const refused = await launcher(["runtime", "start"], { timeoutMs: 300_000 });
    const logs = run("podman", ["logs", "--tail", "40", containerName(isolation, "forge")]);
    details.downgradeStart = refused.code === 0 ? "started" : "refused";
    details.downgradeReason = (`${logs.stdout}${logs.stderr}${output(refused)}`.match(/Database schema version \d+ is newer than this Forge service supports \(\d+\)/) ?? [])[0];
    assert(refused.code !== 0, "the previous release started against the migrated schema");
    assert(details.downgradeReason, "the refusal did not name the newer schema");

    await launcher(["runtime", "stop"]);
    const restore = await requireLauncher(["runtime", "restore", "--from", backup, "--confirm"]);
    details.restoreMs = restore.ms;
    client = await connect();
    await waitForApi(client);
    details.schemaAfterRollback = psql(isolation, "SELECT max(version) FROM forge_schema_migrations");
    assert(taskStatus(await runState(client, runId), "R1") === "waiting-for-approval", "approval wait lost across rollback");
    await whenReachable(() => client.control(runId, "approve-task", { taskId: "R1" }));
    const final = await waitForTerminal(client, runId, 180_000);
    assert(final.status === "complete", `run ended ${final.status} after rollback`);
    details.commits = exactlyOnce(approvalRepo, runId, ["T1", "T2"]);
    useLauncherFrom(current);
  });
  useLauncherFrom(current);
}
