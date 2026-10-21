import { randomUUID } from "node:crypto";
import { commitCounts, type FixtureTask } from "./fixture.ts";
import {
  allEvents,
  attempt,
  runState,
  submit,
  taskStatus,
  waitForTaskStatus,
  waitForTerminal,
  whenReachable,
  type ServiceClient,
} from "./service.ts";
import { assert, containerName, podman, requireLauncher, sleep, waitFor, type Isolation, type Report } from "./support.ts";

/** Deterministically fail the first logical attempt without writing outside its isolated workspace. */
function failFirstAttempt(): string {
  return 'test "$MYFORGE_LOGICAL_ATTEMPT" -gt 1';
}

function taskIsolationProbe(repositoryId: string, peerRepositoryId: string, nonce: string): string {
  const marker = `/repositories/${repositoryId}/.git/hooks/myforge-isolation-${nonce}`;
  const peerHead = `/repositories/${peerRepositoryId}/.git/HEAD`;
  const capabilityCheck = `awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { if ($2 ~ /[1-9a-fA-F]/) exit 1; found++ } /^NoNewPrivs:/ { if ($2 != 1) exit 1; noNewPrivs = 1 } END { if (found != 5 || !noNewPrivs) exit 1 }' /proc/self/status`;
  return `${capabilityCheck} && test "$(id -u)" -gt 0 && test "$HOME" != /root && test ! -r /run/myforge/harness-grants/grants.json && test ! -r '${peerHead}' && ! touch '${marker}' 2>/dev/null`;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly tasks: (nonce: string) => readonly FixtureTask[];
  readonly run: (context: ScenarioContext, details: Record<string, unknown>) => Promise<void>;
}

export interface ScenarioContext {
  readonly isolation: Isolation;
  readonly client: () => Promise<ServiceClient>;
  readonly repoRoot: string;
  readonly nonce: string;
}

function assertExactlyOnce(repoRoot: string, runId: string, taskIds: readonly string[], details: Record<string, unknown>): void {
  const counts = commitCounts(repoRoot, runId);
  details.commits = counts;
  for (const taskId of taskIds) {
    assert(counts[taskId] === 1, `expected exactly one ${taskId} integration commit, found ${counts[taskId] ?? 0}`);
  }
  assert(Object.keys(counts).length === taskIds.length, `unexpected integration commits: ${JSON.stringify(counts)}`);
}

function attemptsFor(run: Awaited<ReturnType<typeof runState>>, taskId: string): number {
  const task = run.tasks.find((entry) => entry.taskId === taskId);
  return Array.isArray(task?.attempts) ? task.attempts.length : 0;
}

/** Kills one service mid-execution, optionally keeps it down, then restarts it. */
function killService(isolation: Isolation, service: string): void {
  podman(["kill", containerName(isolation, service)]);
}

function startService(isolation: Isolation, service: string): void {
  podman(["start", containerName(isolation, service)]);
}

async function crashDuringValidation(
  context: ScenarioContext,
  details: Record<string, unknown>,
  services: readonly string[],
  downMs: number,
): Promise<void> {
  const client = await context.client();
  const submitted = await submit(client, context.repoRoot, { maxRetries: 2, retryDelayMs: 1_000 });
  details.runId = submitted.runId;
  await waitForTaskStatus(client, submitted.runId, "T1", ["running"], 60_000);
  await sleep(4_000);
  const crashedAt = Date.now();
  for (const service of services) killService(context.isolation, service);
  await sleep(downMs);
  for (const service of [...services].reverse()) startService(context.isolation, service);
  const recovered = await whenReachable(() => waitForTaskStatus(client, submitted.runId, "T1", ["complete"], 300_000), 300_000);
  details.recoveryMs = Date.now() - crashedAt;
  details.t1Attempts = attemptsFor(recovered, "T1");
  const final = await whenReachable(() => waitForTerminal(client, submitted.runId, 300_000));
  details.status = final.status;
  assert(final.status === "complete", `run ended ${final.status}`);
  assertExactlyOnce(context.repoRoot, submitted.runId, ["T1", "T2"], details);
}

const LONG_VALIDATION = ["sleep 20"];

const CANCEL_FAILURE_CODES = new Set(["run-cancelled", "execution-cancel"]);

export const FAILURE_SCENARIOS: readonly Scenario[] = [
  {
    id: "F01",
    title: "Duplicate submission keys reuse the run; a changed snapshot under the same key is rejected",
    tasks: () => [{ id: "T1" }],
    async run(context, details) {
      const client = await context.client();
      const key = `qual-dup-${context.nonce}`;
      const first = await submit(client, context.repoRoot, { key });
      const second = await submit(client, context.repoRoot, { key });
      details.runId = first.runId;
      details.duplicateReused = second.reused;
      assert(!first.reused && second.reused && second.runId === first.runId, "duplicate submission was not reused");
      const conflicting = await attempt(() => submit(client, context.repoRoot, { key, maxRetries: 5 }));
      details.conflict = conflicting.ok ? "accepted" : `${conflicting.status} ${conflicting.code}`;
      assert(!conflicting.ok && conflicting.status === 409, "a changed snapshot under a reused key was not rejected");
      const final = await waitForTerminal(client, first.runId, 120_000);
      assert(final.status === "complete", `run ended ${final.status}`);
      assertExactlyOnce(context.repoRoot, first.runId, ["T1"], details);
    },
  },
  {
    id: "F02",
    title: "Worker killed during task execution and held down past the 30 s ownership TTL",
    tasks: () => [{ id: "T1", validation: LONG_VALIDATION }, { id: "T2", dependencies: ["T1"] }],
    run: (context, details) => crashDuringValidation(context, details, ["forge"], 40_000),
  },
  {
    id: "F03",
    title: "Dapr sidecar killed during task execution",
    tasks: () => [{ id: "T1", validation: LONG_VALIDATION }, { id: "T2", dependencies: ["T1"] }],
    run: (context, details) => crashDuringValidation(context, details, ["daprd"], 3_000),
  },
  {
    id: "F04",
    title: "Worker and sidecar killed together during task execution",
    tasks: () => [{ id: "T1", validation: LONG_VALIDATION }, { id: "T2", dependencies: ["T1"] }],
    run: (context, details) => crashDuringValidation(context, details, ["forge", "daprd"], 5_000),
  },
  {
    id: "F05",
    title: "PostgreSQL (workflow and application store) outage during task execution",
    tasks: () => [{ id: "T1", validation: LONG_VALIDATION }, { id: "T2", dependencies: ["T1"] }],
    async run(context, details) {
      const client = await context.client();
      const submitted = await submit(client, context.repoRoot, { maxRetries: 2, retryDelayMs: 1_000 });
      details.runId = submitted.runId;
      await waitForTaskStatus(client, submitted.runId, "T1", ["running"], 60_000);
      await sleep(4_000);
      const outageAt = Date.now();
      podman(["stop", "--time", "10", containerName(context.isolation, "postgres")]);
      await sleep(15_000);
      podman(["start", containerName(context.isolation, "postgres")]);
      const final = await whenReachable(() => waitForTerminal(client, submitted.runId, 420_000), 420_000);
      details.recoveryMs = Date.now() - outageAt;
      details.status = final.status;
      details.t1Attempts = attemptsFor(final, "T1");
      assert(final.status === "complete", `run ended ${final.status}`);
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1", "T2"], details);
    },
  },
  {
    id: "F06",
    title: "Full stack stop/start during a durable retry delay",
    tasks: () => [{ id: "T1", validation: [failFirstAttempt()] }],
    async run(context, details) {
      const retryDelayMs = 60_000;
      let client = await context.client();
      const submitted = await submit(client, context.repoRoot, { maxRetries: 2, retryDelayMs });
      details.runId = submitted.runId;
      const failedAt = await waitFor("T1 attempt 1 to fail", async () => {
        const failed = (await allEvents(client, submitted.runId)).find((event) => event.eventType === "attempt.failed");
        return failed ? Date.parse(String(failed.createdAt ?? "")) || Date.now() : undefined;
      }, 120_000);
      const stop = await requireLauncher(["runtime", "stop"]);
      const start = await requireLauncher(["runtime", "start"]);
      details.restartMs = stop.ms + start.ms;
      client = await context.client();
      const final = await whenReachable(() => waitForTerminal(client, submitted.runId, 300_000));
      const events = await allEvents(client, submitted.runId);
      const secondStart = events.filter((event) => event.eventType === "attempt.started" && event.taskId === "T1")[1];
      const secondStartedAt = Date.parse(String(secondStart?.createdAt ?? ""));
      details.retryFiredAfterMs = Number.isFinite(secondStartedAt) ? secondStartedAt - failedAt : undefined;
      details.status = final.status;
      details.t1Attempts = attemptsFor(final, "T1");
      assert(final.status === "complete", `run ended ${final.status}`);
      assert(details.t1Attempts === 2, `expected two T1 attempts, found ${details.t1Attempts}`);
      assert(typeof details.retryFiredAfterMs === "number" && details.retryFiredAfterMs >= retryDelayMs - 1_000,
        `retry fired after ${details.retryFiredAfterMs} ms, before the ${retryDelayMs} ms durable delay`);
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1"], details);
    },
  },
  {
    id: "F07",
    title: "Approval wait survives worker and sidecar loss; duplicate and stale approvals are handled",
    tasks: () => [{ id: "T1" }, { id: "R1", humanReview: true, dependencies: ["T1"] }, { id: "T2", dependencies: ["R1"] }],
    async run(context, details) {
      const client = await context.client();
      const submitted = await submit(client, context.repoRoot);
      details.runId = submitted.runId;
      await waitForTaskStatus(client, submitted.runId, "R1", ["waiting-for-approval"], 120_000);
      killService(context.isolation, "forge");
      killService(context.isolation, "daprd");
      await sleep(3_000);
      startService(context.isolation, "daprd");
      startService(context.isolation, "forge");
      const waiting = await whenReachable(() => waitForTaskStatus(client, submitted.runId, "R1", ["waiting-for-approval"], 180_000));
      details.waitSurvived = taskStatus(waiting, "R1");
      const unknownTask = await attempt(() => client.control(submitted.runId, "approve-task", { taskId: "T2" }));
      details.notWaitingApproval = unknownTask.ok ? "accepted" : `${unknownTask.status} ${unknownTask.code}`;
      assert(!unknownTask.ok && unknownTask.status === 409, "approval of a task that is not waiting was accepted");
      const forged = await attempt(() => client.control(submitted.runId, "approve-task",
        { taskId: "R1", evidenceDigests: [`sha256:${"0".repeat(64)}`] }));
      details.forgedEvidence = forged.ok ? `accepted ${JSON.stringify(forged.value)}` : `${forged.status} ${forged.code}`;
      const controlId = randomUUID();
      const approved = await whenReachable(() => client.control(submitted.runId, "approve-task", { taskId: "R1" }, controlId));
      const duplicate = await whenReachable(() => client.control(submitted.runId, "approve-task", { taskId: "R1" }, controlId));
      details.approval = approved;
      details.duplicateApproval = duplicate;
      assert(duplicate.reused === true && duplicate.controlId === controlId, "a duplicate approval was not deduplicated");
      const final = await waitForTerminal(client, submitted.runId, 180_000);
      details.status = final.status;
      assert(final.status === "complete", `run ended ${final.status}`);
      const stale = await attempt(() => client.control(submitted.runId, "approve-task", { taskId: "R1" }));
      details.staleApproval = stale.ok ? "accepted" : `${stale.status} ${stale.code}`;
      assert(!stale.ok && (stale.status === 409 || stale.status === 422), "a stale approval after completion was accepted");
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1", "T2"], details);
    },
  },
  {
    id: "F08",
    title: "Cancellation during execution rejects the late task result",
    tasks: () => [{ id: "T1", validation: ["sleep 30"] }, { id: "T2", dependencies: ["T1"] }],
    async run(context, details) {
      const client = await context.client();
      // A short retry delay lets a wrongly retried attempt land inside the observation window.
      const submitted = await submit(client, context.repoRoot, { maxRetries: 2, retryDelayMs: 1_000 });
      details.runId = submitted.runId;
      await waitForTaskStatus(client, submitted.runId, "T1", ["running"], 60_000);
      await sleep(3_000);
      const cancelledAt = Date.now();
      const controlId = randomUUID();
      const cancel = await client.control(submitted.runId, "cancel", {}, controlId);
      const duplicate = await client.control(submitted.runId, "cancel", {}, controlId);
      details.duplicateCancelReused = duplicate.reused;
      assert(duplicate.reused === true, "a duplicate cancel control was not deduplicated");
      details.cancel = cancel;
      const final = await waitForTerminal(client, submitted.runId, 180_000);
      details.cancelToTerminalMs = Date.now() - cancelledAt;
      details.status = final.status;
      assert(final.status === "cancelled", `run ended ${final.status}`);
      // Let the in-flight validation finish so a late result would have had time to land.
      await sleep(35_000);
      const after = await runState(client, submitted.runId);
      details.statusAfterLateResult = after.status;
      details.taskStatuses = Object.fromEntries(after.tasks.map((task) => [task.taskId, task.status]));
      assert(after.status === "cancelled", `run changed to ${after.status} after cancellation`);
      assert(taskStatus(after, "T1") !== "complete" && taskStatus(after, "T2") !== "complete", "a task completed after cancellation");
      const events = await allEvents(client, submitted.runId);
      const cancelledAtSequence = events.find((event) => event.eventType === "run.cancelled")?.sequence as number;
      const lateEvents = events.filter((event) => (event.sequence as number) > cancelledAtSequence);
      details.eventsAfterCancelled = lateEvents.map((event) => {
        const failureCode = (event.detail as Record<string, unknown> | undefined)?.failureCode;
        return failureCode ? `${String(event.eventType)}:${String(failureCode)}` : String(event.eventType);
      });
      // Only the stopped attempt's own failure may still be recorded (for audit); no new attempt or completion.
      const unexpected = lateEvents.filter((event) => {
        const failureCode = (event.detail as Record<string, unknown> | undefined)?.failureCode;
        return event.eventType !== "task.failed" || !CANCEL_FAILURE_CODES.has(String(failureCode));
      });
      assert(unexpected.length === 0, `unexpected events after run.cancelled: ${(details.eventsAfterCancelled as string[]).join(", ")}`);
      const counts = commitCounts(context.repoRoot, submitted.runId);
      details.commits = counts;
      assert(Object.keys(counts).length === 0, `cancelled run integrated commits: ${JSON.stringify(counts)}`);
    },
  },
  {
    id: "F09",
    title: "Duplicate pause/resume controls are acknowledged once and the run completes",
    tasks: () => [{ id: "T1", validation: ["sleep 10"] }, { id: "T2", dependencies: ["T1"] }],
    async run(context, details) {
      const client = await context.client();
      const submitted = await submit(client, context.repoRoot);
      details.runId = submitted.runId;
      await waitForTaskStatus(client, submitted.runId, "T1", ["running"], 60_000);
      const pauseId = randomUUID();
      const pause = await client.control(submitted.runId, "pause", {}, pauseId);
      const pauseAgain = await client.control(submitted.runId, "pause", {}, pauseId);
      assert(!pause.reused && pauseAgain.reused === true, "duplicate pause was not deduplicated");
      await waitFor("run to pause", async () => (await runState(client, submitted.runId)).status === "paused" || undefined, 120_000);
      const paused = await runState(client, submitted.runId);
      details.pausedTasks = Object.fromEntries(paused.tasks.map((task) => [task.taskId, task.status]));
      assert(taskStatus(paused, "T2") !== "running" && taskStatus(paused, "T2") !== "complete", "T2 started while paused");
      const resumeId = randomUUID();
      await client.control(submitted.runId, "resume", {}, resumeId);
      const resumeAgain = await client.control(submitted.runId, "resume", {}, resumeId);
      details.duplicateResumeReused = resumeAgain.reused;
      assert(resumeAgain.reused === true, "duplicate resume was not deduplicated");
      const final = await waitForTerminal(client, submitted.runId, 180_000);
      details.status = final.status;
      assert(final.status === "complete", `run ended ${final.status}`);
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1", "T2"], details);
    },
  },
  {
    id: "F10",
    title: "Repeated worker kills across a four-task chain integrate each task exactly once",
    tasks: () => [
      { id: "T1", validation: ["sleep 8"] },
      { id: "T2", validation: ["sleep 8"], dependencies: ["T1"] },
      { id: "T3", validation: ["sleep 8"], dependencies: ["T2"] },
      { id: "T4", validation: ["sleep 8"], dependencies: ["T3"] },
    ],
    async run(context, details) {
      const client = await context.client();
      const submitted = await submit(client, context.repoRoot, { maxRetries: 3, retryDelayMs: 1_000 });
      details.runId = submitted.runId;
      const kills: string[] = [];
      for (const taskId of ["T2", "T3"]) {
        await whenReachable(() => waitForTaskStatus(client, submitted.runId, taskId, ["running"], 300_000));
        await sleep(3_000 + Math.floor(Math.random() * 4_000));
        killService(context.isolation, "forge");
        kills.push(taskId);
        await sleep(2_000);
        startService(context.isolation, "forge");
      }
      details.killedDuring = kills;
      const final = await whenReachable(() => waitForTerminal(client, submitted.runId, 600_000), 600_000);
      details.status = final.status;
      details.attempts = Object.fromEntries(final.tasks.map((task) => [task.taskId, attemptsFor(final, task.taskId)]));
      assert(final.status === "complete", `run ended ${final.status}`);
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1", "T2", "T3", "T4"], details);
    },
  },
  {
    id: "F11",
    title: "Task UID cannot read harness grants or sibling Git metadata, or write source Git metadata",
    tasks: (nonce) => [{
      id: "T1",
      validation: [taskIsolationProbe(`failures-f11-${nonce}`, `f11-peer-${nonce}`, nonce)],
    }],
    async run(context, details) {
      const client = await context.client();
      const submitted = await submit(client, context.repoRoot);
      details.runId = submitted.runId;
      const final = await waitForTerminal(client, submitted.runId, 120_000);
      details.status = final.status;
      assert(final.status === "complete", `task isolation probe ended ${final.status}`);
      assertExactlyOnce(context.repoRoot, submitted.runId, ["T1"], details);
    },
  },
];

/** Recorded alongside the live results: boundaries the live harness cannot time precisely. */
export const DETERMINISTIC_FAILURE_COVERAGE = [
  { boundary: "Crash after the Git ref update, before the integration receipt", evidence: "tools/dapr-engine/tests/storage/p3-gate.integration.test.ts; conformance C23-C25" },
  { boundary: "Earlier attempt integration pending/ambiguous", evidence: "conformance C30; repository-integration PostgreSQL tests" },
  { boundary: "Stale owner heartbeat/exit/publish after takeover", evidence: "conformance C26-C29; execution ownership PostgreSQL tests" },
  { boundary: "Checkpoint publication crash and reconstruction", evidence: "tests/storage/p3-gate.integration.test.ts (checkpoint reconstruction)" },
  { boundary: "Durable timer/event recovery across sidecar restart", evidence: "P4-01 live recovery evidence (plan.md)" },
] as const;

export async function runFailureSuite(report: Report, contexts: ReadonlyMap<string, ScenarioContext>, only?: ReadonlySet<string>): Promise<void> {
  for (const scenario of FAILURE_SCENARIOS) {
    if (only && !only.has(scenario.id)) continue;
    const context = contexts.get(scenario.id);
    if (!context) throw new Error(`No fixture for ${scenario.id}`);
    await report.scenario(scenario.id, scenario.title, (details) => scenario.run(context, details));
  }
}
