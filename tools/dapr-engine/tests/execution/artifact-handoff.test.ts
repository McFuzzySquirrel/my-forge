import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../execution/artifacts.ts";

test("projects only compact successful artifacts from declared predecessors and input types", (t) => {
  const root = mkdtempSync(join(tmpdir(), "myforge-artifact-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ artifactsPath: root });
  const write = (options: {
    taskId: string;
    type: string;
    status?: "complete" | "failed";
    createdAt: string;
    summary: string;
    agentOutputExcerpt?: string;
  }) => store.write({
    type: options.type,
    category: "work",
    taskId: options.taskId,
    producedBy: "agent",
    status: options.status ?? "complete",
    summary: options.summary,
    inputs: [],
    filesChanged: [`${options.taskId}.ts`],
    payload: {
      agentOutputExcerpt: options.agentOutputExcerpt ?? "full prior conversation that must not be projected",
      decisions: ["decision"],
    },
    nextActions: [],
    createdAt: options.createdAt,
  });

  write({ taskId: "P1", type: "implementation.result", createdAt: "2026-01-01T00:00:00Z", summary: "Older predecessor result." });
  write({ taskId: "P1", type: "implementation.result", createdAt: "2026-01-02T00:00:00Z", summary: "Latest predecessor result." });
  write({ taskId: "P2", type: "implementation.result", createdAt: "2026-01-03T00:00:00Z", summary: "Another declared predecessor." });
  write({ taskId: "UNRELATED", type: "implementation.result", createdAt: "2026-01-04T00:00:00Z", summary: "Must not be projected." });
  write({ taskId: "P1", type: "review.result", createdAt: "2026-01-05T00:00:00Z", summary: "Not a declared input type." });
  write({ taskId: "P2", type: "implementation.result", status: "failed", createdAt: "2026-01-06T00:00:00Z", summary: "Failed artifacts are not handoffs." });

  const projection = store.projectPredecessors({
    taskId: "NEXT",
    predecessorTaskIds: ["P1", "P2"],
    inputTypes: ["implementation.result"],
    fields: ["summary", "filesChanged"],
  });

  assert.deepEqual(
    projection.artifacts.map(({ summary, selectedFields }) => ({ summary, selectedFields })),
    [
      { summary: "Latest predecessor result.", selectedFields: { summary: "Latest predecessor result.", filesChanged: ["P1.ts"] } },
      { summary: "Another declared predecessor.", selectedFields: { summary: "Another declared predecessor.", filesChanged: ["P2.ts"] } },
    ],
  );
  assert.equal(projection.artifacts.some(({ selectedFields }) => "agentOutputExcerpt" in selectedFields), false);
  assert.ok(projection.sourceTokenEstimate > projection.projectedTokenEstimate);
});

test("fails closed when a declared predecessor artifact input is unavailable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "myforge-artifact-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ artifactsPath: root });

  assert.throws(
    () => store.projectPredecessors({
      taskId: "NEXT",
      predecessorTaskIds: ["P1"],
      inputTypes: ["implementation.result"],
    }),
    /requires predecessor artifact type 'implementation.result'/,
  );
});
