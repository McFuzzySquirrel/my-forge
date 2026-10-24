import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePhaseIds, resolvePhaseTaskIds } from "./phase-selection.ts";

const manifest = {
  phases: [
    { id: "phase-1", tasks: [{ id: "T1" }, { id: "T2" }] },
    { id: "phase-2", tasks: [{ id: "T3" }] },
    { id: "phase-3", tasks: [{ id: "T4" }, { id: "T5" }] },
  ],
};

test("parses comma-separated phase ids without duplicates", () => {
  assert.deepEqual(parsePhaseIds(" phase-1, phase-2,phase-1 "), ["phase-1", "phase-2"]);
  assert.deepEqual(parsePhaseIds(""), []);
});

test("resolves selected phases to manifest-ordered task ids", () => {
  assert.deepEqual(resolvePhaseTaskIds(manifest, ["phase-2"]), ["T3"]);
  assert.deepEqual(resolvePhaseTaskIds(manifest, ["phase-3", "phase-1"]), ["T1", "T2", "T4", "T5"]);
});

test("rejects unknown, duplicate, and empty phase selections", () => {
  assert.throws(() => resolvePhaseTaskIds(manifest, ["missing"]), /Unknown phase 'missing'/);
  assert.throws(() => resolvePhaseTaskIds({ phases: [{ id: "phase-1", tasks: [] }] }, ["phase-1"]), /contain no tasks/);
  assert.throws(() => resolvePhaseTaskIds({ phases: [{ id: "phase-1", tasks: [{ id: "T1" }] }, { id: "phase-1", tasks: [] }] }, ["phase-1"]), /duplicate phase/);
  assert.throws(() => resolvePhaseTaskIds({}, ["phase-1"]), /no phase list/);
});
