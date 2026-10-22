import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEngineHarnessAvailable } from "./engine-config.ts";

test("retired harness remains rejected by launcher configuration", () => {
  assert.throws(() => assertEngineHarnessAvailable("flowforge-kernel"), /has been retired/);
  for (const harness of ["copilot", "opencode", "openai", "stub"]) {
    assert.doesNotThrow(() => assertEngineHarnessAvailable(harness));
  }
});
