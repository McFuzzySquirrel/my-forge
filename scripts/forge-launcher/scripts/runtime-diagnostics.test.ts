import assert from "node:assert/strict";
import test from "node:test";
import { podmanUnavailableMessage, remediationHints, withRemediation } from "./runtime-diagnostics.ts";

test("remediation hints recognize version, corruption, credential, and resource failures", () => {
  const cases: [string, RegExp][] = [
    ["Error: Database schema version 9 is newer than this Forge service supports (7)", /Version mismatch.*Downgrades are not supported/],
    ["FATAL: database files are incompatible with server", /Version mismatch/],
    ["Applied database migration 2 (runs) no longer matches its recorded checksum", /schema history/],
    ["PANIC: could not locate a valid checkpoint record", /corrupt.*runtime restore/],
    ['FATAL: password authentication failed for user "forge_app"', /Credential mismatch.*runtime.env/],
    ["write /var/lib/postgresql: no space left on device", /Out of disk space/],
    ["forge: exited OOMKilled", /out of memory/],
    ["listen tcp 127.0.0.1:8483: bind: address already in use", /MYFORGE_API_PORT/],
    ["Error: initializing source docker://daprio/daprd: dial tcp: lookup registry-1.docker.io: no such host", /images could not be pulled.*offline/],
  ];
  for (const [output, expected] of cases) {
    const hints = remediationHints(output, "linux");
    assert.equal(hints.length, 1, output);
    assert.match(hints[0]!, expected);
  }
  assert.deepEqual(remediationHints("everything is fine", "linux"), []);
});

test("platform-specific hints mention the Podman machine only where one exists", () => {
  assert.match(remediationHints("no space left on device", "darwin")[0]!, /podman machine set --disk-size/);
  assert.doesNotMatch(remediationHints("no space left on device", "linux")[0]!, /podman machine/);
  assert.match(podmanUnavailableMessage("missing", "win32"), /podman machine init/);
  assert.doesNotMatch(podmanUnavailableMessage("missing", "linux"), /podman machine/);
  assert.match(podmanUnavailableMessage("unreachable", "darwin"), /podman machine start/);
  assert.match(podmanUnavailableMessage("unreachable", "linux", "cannot connect to Podman socket"), /podman info/);
  assert.match(podmanUnavailableMessage("not-rootless", "linux"), /not root/);
  assert.match(podmanUnavailableMessage("no-compose", "linux"), /podman-compose/);
});

test("withRemediation leaves messages without known signatures unchanged", () => {
  assert.equal(withRemediation("failed", "unknown output"), "failed");
  assert.match(withRemediation("failed", "no space left on device", "linux"), /^failed\nHint: Out of disk space/);
});
