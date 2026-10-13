// Keeps contract v1 §5 and the runnable fixtures in lockstep: every normative
// case ID has exactly one named fixture, and no fixture cites an unknown case.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const contractPath = fileURLToPath(new URL("../../../../docs/contracts/dapr-execution-v1.md", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));

function contractCaseIds(): Map<string, string> {
  const markdown = readFileSync(contractPath, "utf8");
  const section = markdown.split("## 5. Conformance matrix")[1]?.split(/\n## /)[0] ?? "";
  const ids = new Map<string, string>();
  for (const match of section.matchAll(/^\| (C\d{2}) \| [^|]+ \| [^|]+ \| `([^`]+)` \|/gm)) ids.set(match[1], match[2]);
  return ids;
}

function fixtureCaseIds(): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const file of readdirSync(fixtureDirectory).filter((name) => name.endsWith(".test.ts") && name !== "matrix.test.ts")) {
    const source = readFileSync(`${fixtureDirectory}${file}`, "utf8");
    for (const match of source.matchAll(/test\(\s*[`"](C\d{2}):/g)) ids.set(match[1], [...(ids.get(match[1]) ?? []), file]);
  }
  return ids;
}

test("every contract §5 conformance case has a runnable fixture in its named file", () => {
  const contract = contractCaseIds();
  const fixtures = fixtureCaseIds();
  assert.ok(contract.size >= 16, `expected the §5 matrix to list case IDs, found ${contract.size}`);
  for (const [id, file] of contract) {
    assert.deepEqual([...new Set(fixtures.get(id) ?? [])], [file], `${id} must have fixture(s) only in ${file}`);
  }
  for (const id of fixtures.keys()) assert.ok(contract.has(id), `${id} is not listed in contract §5`);
});
