// Child worker for the C26 worker-death fixtures. It launches an owned harness
// through runCommand and then fails in the requested way, so the fixture can
// check that no harness descendant outlives the worker.
//
// argv: mode (crash | die-before-reap | freeze), scratch directory, timeoutMs.
import { join } from "node:path";
import { harnessProcessOptions, runCommand } from "../../../execution/index.ts";

const [mode, cwd, timeoutText] = process.argv.slice(2);
if (!mode || !cwd) throw new Error("usage: lifecycle-worker <mode> <cwd> [timeoutMs]");
const pidFile = join(cwd, "descendant.pid");
const script = mode === "die-before-reap"
  ? `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"`
  : `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; wait`;

void runCommand("sh", ["-c", script], {
  cwd,
  timeoutMs: Number(timeoutText ?? 30_000),
  maxBufferBytes: 64 * 1024,
  ...harnessProcessOptions({ isolation: { environment: { PATH: process.env["PATH"] ?? "" } } }),
});

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === "die-before-reap") {
  // The harness exits while the event loop is blocked; the worker dies before
  // it can handle the exit message and reap the leftover descendant.
  block(750);
  process.kill(process.pid, "SIGKILL");
} else if (mode === "freeze") {
  // An unresponsive worker never runs its own timeout timer.
  block(60_000);
}
// "crash": stay alive until the fixture SIGKILLs this worker.
setInterval(() => undefined, 1000);
