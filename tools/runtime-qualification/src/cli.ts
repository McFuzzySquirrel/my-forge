import { randomBytes } from "node:crypto";
import path from "node:path";
import { createFixtureRepo } from "./fixture.ts";
import { DETERMINISTIC_FAILURE_COVERAGE, FAILURE_SCENARIOS, runFailureSuite, type Scenario, type ScenarioContext } from "./failures.ts";
import { connect, waitForApi } from "./service.ts";
import { hostEnvironment, isolate, launcher, Report, requireLauncher, type Isolation } from "./support.ts";

const USAGE = `Usage: npm run qualify -- <suite> [--root <abs-dir>] [--only <id,id>] [--report <file>] [--teardown]

Suites:
  failures   P6-01 failure boundaries (worker/sidecar/store loss, retry timer,
             approval wait, duplicate submissions and controls, cancellation)

Runs against an isolated Compose project (myforge-qual, API port 18483, data
under --root, default /tmp/myforge-qual); the operator's myforge-runtime
installation is never touched. --teardown resets the isolated runtime at the end.`;

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
  let root = "/tmp/myforge-qual";
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
    contexts.set(scenario.id, { isolation, client: connect, repoRoot, nonce });
  }
  await launcher(["runtime", "stop"]);
  const started = await requireLauncher(["runtime", "start"]);
  process.stdout.write(`Isolated runtime ${isolation.project} started in ${Math.round(started.ms / 1000)} s\n`);
  await waitForApi(await connect());
  return contexts;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  const isolation = isolate(options.root);
  const report = new Report(options.suite, { ...hostEnvironment(), project: isolation.project, apiPort: isolation.apiPort });
  try {
    switch (options.suite) {
      case "failures": {
        const scenarios = FAILURE_SCENARIOS.filter((scenario) => !options.only || options.only.has(scenario.id));
        const contexts = await prepare(isolation, options.suite, scenarios);
        await runFailureSuite(report, contexts, options.only);
        report.environment.deterministicCoverage = DETERMINISTIC_FAILURE_COVERAGE;
        break;
      }
      default:
        throw new Error(`Unknown suite '${options.suite}'.\n${USAGE}`);
    }
  } finally {
    const file = options.report ?? path.join(options.root, "reports", `${options.suite}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    report.write(file);
    process.stdout.write(`\nReport: ${file}\n`);
    if (options.teardown) await launcher(["runtime", "reset", "--confirm"]);
  }
  const failed = report.entries.filter((entry) => !entry.passed).map((entry) => entry.id);
  process.stdout.write(failed.length ? `FAILED: ${failed.join(", ")}\n` : `All ${report.entries.length} scenarios passed.\n`);
  return report.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
