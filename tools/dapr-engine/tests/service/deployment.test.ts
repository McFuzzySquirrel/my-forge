import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const deploy = join(import.meta.dirname, "..", "..", "deploy");

function publishedPorts(file: string): string[] {
  const ports: string[] = [];
  let inPorts = false;
  let indent = 0;
  for (const line of readFileSync(join(deploy, file), "utf8").split("\n")) {
    const current = line.length - line.trimStart().length;
    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      indent = current;
      continue;
    }
    if (!inPorts || !line.trim() || line.trim().startsWith("#")) continue;
    const entry = line.match(/^\s*-\s*"?([^"]+)"?\s*$/);
    if (current > indent && entry) ports.push(entry[1]!);
    else inPorts = false;
  }
  return ports;
}

test("the local deployment publishes ports only on loopback", () => {
  const ports = [...publishedPorts("compose.yaml"), ...publishedPorts("compose.host-tools.yaml")];
  assert.ok(ports.length >= 2, "expected the run API and host-tools PostgreSQL ports");
  for (const port of ports) assert.match(port, /^127\.0\.0\.1:/, `port ${port} must bind loopback`);
});

test("the Dapr sidecar and the worker share a required API token", () => {
  const compose = readFileSync(join(deploy, "compose.yaml"), "utf8");
  const required = compose.match(/DAPR_API_TOKEN: "\$\{DAPR_API_TOKEN:\?DAPR_API_TOKEN is required\}"/g) ?? [];
  assert.equal(required.length, 2);
});
