import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { must } from "./support.ts";

const HISTORY_EVENT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "dapr-engine", "node_modules", "@dapr", "dapr", "workflow", "internal", "durabletask", "proto",
  "orchestrator_service_pb.js",
);

interface Captured {
  readonly instanceId: string;
  readonly workflow: string;
  readonly features: readonly string[];
  readonly events: readonly string[];
}

/** Event kinds that make a history worth keeping as a replay fixture. */
function features(pb: any, events: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const encoded of events) {
    const event = pb.HistoryEvent.deserializeBinary(Buffer.from(encoded, "base64"));
    if (event.hasTimercreated()) seen.add("timer");
    if (event.hasEventraised()) seen.add(`event:${event.getEventraised().getName()}`);
    if (event.hasSuborchestrationinstancefailed()) seen.add("child-failed");
    if (event.hasTaskfailed()) seen.add("activity-failed");
    if (event.hasExecutioncompleted()) seen.add(`completed:${event.getExecutioncompleted().getOrchestrationstatus()}`);
    if (event.hasContinueasnew?.()) seen.add("continue-as-new");
  }
  return [...seen].sort();
}

/** Every action the orchestrator took must be present: ids 1..n without gaps. */
function contiguous(pb: any, events: readonly string[]): boolean {
  const ids = events
    .map((encoded) => pb.HistoryEvent.deserializeBinary(Buffer.from(encoded, "base64")))
    .filter((event: any) => event.getEventid() >= 0)
    .map((event: any) => event.getEventid() as number);
  return ids.every((id, index) => id === index + 1);
}

/**
 * Exports recorded Dapr workflow histories from an isolated installation's
 * PostgreSQL state store. Picks one terminal history per distinct feature
 * set (timers, external events, failures) and writes them as base64
 * HistoryEvent protobufs for the engine's replay test.
 */
export async function captureHistories(project: string, output: string, limit: number): Promise<number> {
  const module = await import(HISTORY_EVENT);
  const pb = module.HistoryEvent ? module : module.default;
  const rows = must("podman", ["exec", `${project}_postgres_1`, "psql", "-U", "postgres", "-d", "myforge_dapr", "-AtF", "\t", "-c",
    "SELECT split_part(key, '||', 3), split_part(key, '||', 4), encode(value, 'hex') FROM state " +
    "WHERE key LIKE '%.workflow||%||history-%' ORDER BY 1, 2"]);
  const histories = new Map<string, string[]>();
  for (const line of rows.split("\n")) {
    const [instanceId, , value] = line.split("\t");
    if (!instanceId || !value) continue;
    (histories.get(instanceId) ?? histories.set(instanceId, []).get(instanceId)!).push(Buffer.from(value, "hex").toString("base64"));
  }
  const chosen = new Map<string, Captured>();
  for (const [instanceId, events] of histories) {
    const first = pb.HistoryEvent.deserializeBinary(Buffer.from(events.find((encoded) =>
      pb.HistoryEvent.deserializeBinary(Buffer.from(encoded, "base64")).hasExecutionstarted()) ?? events[0]!, "base64"));
    const workflow = first.hasExecutionstarted() ? first.getExecutionstarted().getName() : "";
    if (!workflow.startsWith("runOrchestration") && !workflow.startsWith("taskAttempt")) continue;
    if (!contiguous(pb, events)) {
      process.stderr.write(`skipping ${instanceId}: action event ids are not contiguous\n`);
      continue;
    }
    const kinds = features(pb, events);
    if (!kinds.some((kind) => kind.startsWith("completed:"))) continue;
    const key = `${workflow}|${kinds.join(",")}`;
    const existing = chosen.get(key);
    if (!existing || existing.events.length > events.length) chosen.set(key, { instanceId, workflow, features: kinds, events });
  }
  const selected = [...chosen.values()].sort((a, b) => a.workflow.localeCompare(b.workflow) || a.features.join().localeCompare(b.features.join())).slice(0, limit);
  mkdirSync(output, { recursive: true });
  for (const history of selected) {
    const name = `${history.workflow}-${history.features.join("_").replace(/[^a-z0-9_-]+/gi, "-") || "plain"}.json`;
    writeFileSync(path.join(output, name), `${JSON.stringify({ schema: 1, capturedFrom: "live qualification", ...history }, null, 2)}\n`);
    process.stdout.write(`${name} (${history.events.length} events)\n`);
  }
  return selected.length;
}
