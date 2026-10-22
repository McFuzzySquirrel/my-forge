import { randomBytes } from "node:crypto";
import path from "node:path";
import { createFixtureRepo } from "./fixture.ts";
import { captureHistories } from "./histories.ts";
import { removeInstallation, runBackupSuite } from "./backup.ts";
import { runCutoverSuite } from "./cutover.ts";
import { PREVIOUS_RELEASE, removePreviousRelease, runUpgradeSuite } from "./upgrade.ts";
import { DETERMINISTIC_FAILURE_COVERAGE, FAILURE_SCENARIOS, runFailureSuite, type Scenario, type ScenarioContext } from "./failures.ts";
import { connect, waitForApi } from "./service.ts";
import { activate, hostEnvironment, isolate, launcher, Report, requireLauncher, type Isolation } from "./support.ts";

const USAGE = `Usage: npm run qualify -- <suite> [--root <abs-dir>] [--only <id,id>] [--report <file>] [--teardown]

Suites:
  failures   P6-01 failure boundaries (worker/sidecar/store loss, retry timer,
             approval wait, duplicate submissions and controls, cancellation)
  backup     P6-02 backup/restore (fresh-installation restore with a pending
             timer and approval, damaged archives, Git behind/ahead of stores);
             also uses a second installation (myforge-qual2, port 18484,
             data under <root>2)
  upgrade    P6-03 upgrade/rollback from the previous release (${PREVIOUS_RELEASE},
             checked out as a git worktree under --root) with an approval wait
             and a pending retry timer in flight
  cutover    P7-01/02 migration/rollback rehearsal with archived legacy state,
             fresh Dapr runs, stopped writers, and preserved Git changes

Also: capture-histories <project> <output-dir> [limit] exports recorded workflow
histories from an isolated installation as replay fixtures (P6-03).

Suites use isolated Compose projects and never touch the operator's myforge-runtime:
  failures/backup/upgrade: myforge-qual, API port 18483, default /tmp/myforge-qual
  cutover:                 myforge-p7, API port 18485, default /tmp/myforge-p7-cutover
--teardown resets the isolated runtime at the end.`;

interface Options {
  readonly suite: string;
  readonly root: string;
  readonly only?: ReadonlySet<string>;
  readonly report?: string;
  readonly teardown: boolean;
}

function parse(args: readonly string[]): Options {
  const [suite, ...rest] = args;
  if (!suite || suite === "--help" || suite === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(suite ? 0 : 2);
  }
  let root = suite === "cutover" ? "/tmp/myforge-p7-cutover" : "/tmp/myforge-qual";
  let only: Set<string> | undefined;
  let report: string | undefined;
  let teardown = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--root") root = path.resolve(value());
    else if (flag === "--only") only = new Set(value().split(",").map((id) => id.trim().toUpperCase()).filter(Boolean));
    else if (flag === "--report") report = path.resolve(value());
    else if (flag === "--teardown") teardown = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { suite, root, ...(only ? { only } : {}), ...(report ? { report } : {}), teardown };
}

/** Creates one fixture repository per scenario, registers them, and (re)starts the isolated runtime. */
async function prepare(isolation: Isolation, suite: string, scenarios: readonly Scenario[]): Promise<Map<string, ScenarioContext>> {
  const nonce = randomBytes(3).toString("hex");
  const contexts = new Map<string, ScenarioContext>();
  for (const scenario of scenarios) {
    const repoRoot = createFixtureRepo(isolation.root, `${suite}-${scenario.id.toLowerCase()}-${nonce}`, scenario.tasks(nonce));
    await requireLauncher(["runtime", "repo", "add", repoRoot]);
    if (scenario.id === "F11") {
      const peerRepositoryId = `f11-peer-${nonce}`;
      const peerRoot = createFixtureRepo(isolation.root, `${suite}-${scenario.id.toLowerCase()}-peer-${nonce}`, []);
      await requireLauncher(["runtime", "repo", "add", peerRoot, "--id", peerRepositoryId]);
    }
    contexts.set(scenario.id, { isolation, client: connect, repoRoot, nonce });
  }
  await launcher(["runtime", "stop"]);
  const started = await requireLauncher(["runtime", "start"]);
  process.stdout.write(`Isolated runtime ${isolation.project} started in ${Math.round(started.ms / 1000)} s\n`);
  await waitForApi(await connect());
  return contexts;
}

async function main(): Promise<number> {
  if (process.argv[2] === "capture-histories") {
    const [, , , project, output, limit] = process.argv;
    if (!project || !output) throw new Error("Usage: npm run qualify -- capture-histories <project> <output-dir> [limit]");
    if (project === "myforge-runtime") throw new Error("Refusing to read the operator installation.");
    return await captureHistories(project, path.resolve(output), Number(limit ?? 20)) > 0 ? 0 : 1;
  }
  const options = parse(process.argv.slice(2));
  const isolation = options.suite === "cutover"
    ? isolate(options.root, "myforge-p7", 18485)
    : isolate(options.root);
  const report = new Report(options.suite, { ...hostEnvironment(), project: isolation.project, apiPort: isolation.apiPort });
  const extraInstallations: Isolation[] = [];
  try {
    switch (options.suite) {
      case "failures": {
        const scenarios = FAILURE_SCENARIOS.filter((scenario) => !options.only || options.only.has(scenario.id));
        const contexts = await prepare(isolation, options.suite, scenarios);
        await runFailureSuite(report, contexts, options.only);
        report.environment.deterministicCoverage = DETERMINISTIC_FAILURE_COVERAGE;
        break;
      }
      case "backup":
        extraInstallations.push(await runBackupSuite(report, options.root));
        break;
      case "upgrade":
        await runUpgradeSuite(report, isolation);
        break;
      case "cutover":
        await runCutoverSuite(report, isolation);
        break;
      default:
        throw new Error(`Unknown suite '${options.suite}'.\n${USAGE}`);
    }
  } finally {
    const file = options.report ?? path.join(options.root, "reports", `${options.suite}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    report.write(file);
    process.stdout.write(`\nReport: ${file}\n`);
    if (options.teardown) {
      for (const extra of extraInstallations) {
        activate(extra);
        await launcher(["runtime", "reset", "--confirm"]);
        removeInstallation(extra);
      }
      activate(isolation);
      await launcher(["runtime", "reset", "--confirm"]);
      if (options.suite === "upgrade" || options.suite === "cutover") removePreviousRelease(options.root);
    }
  }
  const failed = report.entries.filter((entry) => !entry.passed).map((entry) => entry.id);
  process.stdout.write(failed.length ? `FAILED: ${failed.join(", ")}\n` : `All ${report.entries.length} scenarios passed.\n`);
  return report.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
