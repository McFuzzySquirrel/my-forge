import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { listRegisteredRepositories } from "../../../scripts/forge-launcher/scripts/runtime-repositories.ts";
import { commitCounts, createFixtureRepo, type FixtureTask } from "./fixture.ts";
import { allEvents, connect, runState, submit, taskStatus, waitForApi, waitForTaskStatus, waitForTerminal, whenReachable } from "./service.ts";
import {
  activate,
  assert,
  containerState,
  isolate,
  launcher,
  must,
  requireLauncher,
  waitFor,
  type Isolation,
  type Report,
} from "./support.ts";

/** Deterministically fail the first logical attempt without writing outside its isolated workspace. */
function failFirstAttempt(): string {
  return 'test "$MYFORGE_LOGICAL_ATTEMPT" -gt 1';
}

const RETRY_DELAY_MS = 240_000;
const FORGE_REF = "refs/heads/forge/main";

function assertExactlyOnce(repoRoot: string, runId: string, taskIds: readonly string[], details: Record<string, unknown>, key = "commits"): void {
  const counts = commitCounts(repoRoot, runId);
  details[key] = counts;
  for (const taskId of taskIds) assert(counts[taskId] === 1, `expected exactly one ${taskId} commit, found ${counts[taskId] ?? 0}`);
  assert(Object.keys(counts).length === taskIds.length, `unexpected integration commits: ${JSON.stringify(counts)}`);
}

async function backup(root: string, name: string): Promise<string> {
  const target = path.join(root, "backups", `${name}-${randomBytes(3).toString("hex")}`);
  mkdirSync(path.dirname(target), { recursive: true });
  await requireLauncher(["runtime", "backup", "--output", target]);
  return target;
}

/** The launcher reports errors on stdout; check both streams. */
function output(result: { readonly stdout: string; readonly stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function lastLine(result: { readonly stdout: string; readonly stderr: string }): string {
  return output(result).split("\n").at(-1) ?? "";
}

function servicesRunning(isolation: Isolation): boolean {
  return ["postgres", "daprd", "forge"].every((service) => containerState(isolation, service) === "running");
}

function failureCode(events: readonly Record<string, unknown>[], taskId: string): string | undefined {
  const failed = [...events].reverse().find((event) => event.eventType === "task.failed" && event.taskId === taskId);
  return (failed?.detail as Record<string, unknown> | undefined)?.failureCode as string | undefined;
}

/**
 * P6-02: backup and restore. Builds pending durable state on the source
 * installation (myforge-qual), restores it into a fresh installation
 * (myforge-qual2), and checks archive tampering and Git/store drift there.
 */
export async function runBackupSuite(report: Report, root: string): Promise<Isolation> {
  const nonce = randomBytes(3).toString("hex");
  const source = isolate(root);
  // The target is disposable: start every suite from a fresh installation.
  const target = isolate(`${root}2`, "myforge-qual2", 18484);
  await launcher(["runtime", "reset", "--confirm"]);
  removeInstallation(target);
  mkdirSync(target.runtimeDir, { recursive: true });
  activate(source);
  const repo = (name: string, tasks: readonly FixtureTask[]) =>
    createFixtureRepo(source.root, `backup-${name}-${nonce}`, tasks);
  const timerRepo = repo("timer", [{ id: "T1", validation: [failFirstAttempt()] }]);
  const approvalRepo = repo("approval", [{ id: "T1" }, { id: "R1", humanReview: true, dependencies: ["T1"] }, { id: "T2", dependencies: ["R1"] }]);
  const behindRepo = repo("behind", [{ id: "T1" }, { id: "R1", humanReview: true, dependencies: ["T1"] }, { id: "T2", dependencies: ["R1"] }]);
  const aheadRepo = repo("ahead", [{ id: "T1", validation: ["sleep 15"] }, { id: "R1", humanReview: true, dependencies: ["T1"] }]);
  for (const repoRoot of [timerRepo, approvalRepo, behindRepo, aheadRepo]) await requireLauncher(["runtime", "repo", "add", repoRoot]);
  await launcher(["runtime", "stop"]);
  await requireLauncher(["runtime", "start"]);
  await waitForApi(await connect());

  let b01Backup: string | undefined;
  let timerRun = "";
  let approvalRun = "";
  let timerFailedAt = 0;

  await report.scenario("B01", "Restore into a fresh installation keeps a pending retry timer and an approval wait", async (details) => {
    let client = await connect();
    timerRun = (await submit(client, timerRepo, { maxRetries: 2, retryDelayMs: RETRY_DELAY_MS })).runId;
    approvalRun = (await submit(client, approvalRepo)).runId;
    details.runs = { timerRun, approvalRun };
    timerFailedAt = await waitFor("timer run attempt 1 to fail", async () => {
      const failed = (await allEvents(client, timerRun)).find((event) => event.eventType === "attempt.failed");
      return failed ? Date.parse(String(failed.createdAt ?? "")) || Date.now() : undefined;
    }, 120_000);
    await waitForTaskStatus(client, approvalRun, "R1", ["waiting-for-approval"], 120_000);

    const backupStarted = Date.now();
    b01Backup = await backup(source.root, "b01");
    details.backupMs = Date.now() - backupStarted;
    details.backup = b01Backup;
    // The source must not keep executing the same repositories once the target owns them.
    await requireLauncher(["runtime", "stop"]);

    // Register every repository the source knew, under the same IDs, in the fresh installation.
    const registry = await listRegisteredRepositories(source.runtimeDir);
    details.registeredRepositories = registry.length;
    activate(target);
    for (const entry of registry) await requireLauncher(["runtime", "repo", "add", entry.path, "--id", entry.id]);
    // A fresh installation with its own credentials refuses the restore and keeps running.
    await requireLauncher(["runtime", "start"]);
    const refused = await launcher(["runtime", "restore", "--from", b01Backup, "--confirm"]);
    details.credentialMismatch = refused.code !== 0 && /different database credentials/.test(output(refused))
      ? "refused" : `exit ${refused.code}: ${lastLine(refused)}`;
    assert(details.credentialMismatch === "refused", "restore with different credentials was not refused");
    assert(servicesRunning(target), "a refused restore disturbed the target installation");

    await requireLauncher(["runtime", "stop"]);
    copyFileSync(path.join(source.runtimeDir, "runtime.env"), path.join(target.runtimeDir, "runtime.env"));
    const restore = await requireLauncher(["runtime", "restore", "--from", b01Backup, "--confirm"]);
    details.restoreMs = restore.ms;
    client = await connect();
    await waitForApi(client);

    const restoredApproval = await runState(client, approvalRun);
    details.approvalAfterRestore = taskStatus(restoredApproval, "R1");
    assert(details.approvalAfterRestore === "waiting-for-approval", `R1 was ${details.approvalAfterRestore} after restore`);
    await whenReachable(() => client.control(approvalRun, "approve-task", { taskId: "R1" }));
    const approvalFinal = await waitForTerminal(client, approvalRun, 180_000);
    assert(approvalFinal.status === "complete", `approval run ended ${approvalFinal.status}`);
    assertExactlyOnce(approvalRepo, approvalRun, ["T1", "T2"], details, "approvalCommits");

    const timerFinal = await waitForTerminal(client, timerRun, RETRY_DELAY_MS + 180_000);
    const events = await allEvents(client, timerRun);
    const retried = events.filter((event) => event.eventType === "attempt.started" && event.taskId === "T1")[1];
    details.retryFiredAfterMs = Date.parse(String(retried?.createdAt ?? "")) - timerFailedAt;
    assert(timerFinal.status === "complete", `timer run ended ${timerFinal.status}`);
    assert((details.retryFiredAfterMs as number) >= RETRY_DELAY_MS - 1_000,
      `retry fired after ${details.retryFiredAfterMs} ms, before the ${RETRY_DELAY_MS} ms durable delay`);
    assertExactlyOnce(timerRepo, timerRun, ["T1"], details, "timerCommits");
  });

  await report.scenario("B02", "Tampered, incomplete, and manifest-less backups are rejected without touching the installation", async (details) => {
    assert(b01Backup, "B01 did not produce a backup");
    activate(target);
    const variants: Record<string, (directory: string) => void> = {
      tampered: (directory) => writeFileSync(path.join(directory, "postgres_data.tar"), "tampered", { flag: "a" }),
      missingVolume: (directory) => unlinkSync(path.join(directory, "scheduler_data.tar")),
      missingManifest: (directory) => unlinkSync(path.join(directory, "manifest.json")),
    };
    const outcomes: Record<string, string> = {};
    for (const [name, damage] of Object.entries(variants)) {
      const copy = path.join(target.root, "backups", `b02-${name}-${nonce}`);
      cpSync(b01Backup, copy, { recursive: true });
      damage(copy);
      const result = await launcher(["runtime", "restore", "--from", copy, "--confirm"]);
      outcomes[name] = result.code === 0 ? "accepted" : lastLine(result) || `exit ${result.code}`;
      rmSync(copy, { recursive: true, force: true });
      assert(result.code !== 0, `${name} backup was restored`);
    }
    details.outcomes = outcomes;
    assert(servicesRunning(target), "a rejected restore stopped the installation");
    const client = await connect();
    details.restoredRunsIntact = (await runState(client, approvalRun)).status;
    assert(details.restoredRunsIntact === "complete", "restored state changed after rejected restores");
  });

  await report.scenario("B03", "Git behind the stores: drift is refused, and a forced restore fails the run instead of accepting it", async (details) => {
    activate(target);
    const client = await connect();
    const runId = (await submit(client, behindRepo)).runId;
    details.runId = runId;
    await waitForTaskStatus(client, runId, "R1", ["waiting-for-approval"], 120_000);
    const accepted = must("git", ["rev-parse", FORGE_REF], behindRepo);
    const backupDir = await backup(target.root, "b03");
    // Git loses the accepted T1 commit (for example, the repository is restored from an older copy).
    must("git", ["update-ref", FORGE_REF, `${accepted}^`], behindRepo);
    const refused = await launcher(["runtime", "restore", "--from", backupDir, "--confirm"]);
    details.driftRefused = refused.code !== 0 && /Git no longer matches the backup/.test(output(refused));
    assert(details.driftRefused, `drifted restore was not refused: ${lastLine(refused)}`);
    assert(servicesRunning(target), "a refused restore stopped the installation");

    await requireLauncher(["runtime", "restore", "--from", backupDir, "--confirm", "--allow-git-drift"]);
    const restored = await connect();
    await waitForApi(restored);
    await whenReachable(() => restored.control(runId, "approve-task", { taskId: "R1" }));
    const final = await waitForTerminal(restored, runId, 300_000);
    details.status = final.status;
    details.t2FailureCode = failureCode(await allEvents(restored, runId), "T2");
    details.forgeRef = must("git", ["rev-parse", FORGE_REF], behindRepo) === `${must("git", ["rev-parse", `${accepted}^`], behindRepo)}` ? "unchanged" : "moved";
    assert(final.status === "failed", `run ended ${final.status} on a branch missing its accepted work`);
    assert(details.t2FailureCode === "integration-history-missing", `T2 failed with ${details.t2FailureCode}`);
    assert(details.forgeRef === "unchanged", "T2 was integrated on top of the incomplete branch");
  });

  await report.scenario("B04", "Git ahead of the stores: drift is refused; resetting to the recorded tip re-runs the task exactly once", async (details) => {
    activate(target);
    let client = await connect();
    const runId = (await submit(client, aheadRepo)).runId;
    details.runId = runId;
    await waitForTaskStatus(client, runId, "T1", ["running"], 60_000);
    const recorded = must("git", ["rev-parse", FORGE_REF], aheadRepo);
    const backupDir = await backup(target.root, "b04");
    client = await connect();
    await whenReachable(() => waitForTaskStatus(client, runId, "R1", ["waiting-for-approval"], 300_000));
    assertExactlyOnce(aheadRepo, runId, ["T1"], details, "commitsBeforeRestore");

    const refused = await launcher(["runtime", "restore", "--from", backupDir, "--confirm"]);
    const hint = output(refused).match(/git -C \S+ update-ref (\S+) ([0-9a-f]{40})/);
    details.driftRefused = refused.code !== 0 && Boolean(hint);
    assert(details.driftRefused, `drifted restore was not refused with a reset hint: ${lastLine(refused)}`);
    assert(hint![1] === FORGE_REF && hint![2] === recorded, `reset hint ${hint![1]} ${hint![2]} does not match the recorded tip ${recorded}`);

    must("git", ["update-ref", FORGE_REF, recorded], aheadRepo);
    await requireLauncher(["runtime", "restore", "--from", backupDir, "--confirm"]);
    client = await connect();
    await waitForApi(client);
    await whenReachable(() => waitForTaskStatus(client, runId, "R1", ["waiting-for-approval"], 300_000));
    await whenReachable(() => client.control(runId, "approve-task", { taskId: "R1" }));
    const final = await waitForTerminal(client, runId, 180_000);
    details.status = final.status;
    assert(final.status === "complete", `run ended ${final.status}`);
    assertExactlyOnce(aheadRepo, runId, ["T1"], details);
  });

  return target;
}

export function removeInstallation(isolation: Isolation): void {
  if (existsSync(isolation.root)) rmSync(isolation.root, { recursive: true, force: true });
}
