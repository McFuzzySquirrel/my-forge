const message = [
  "The in-process workflow-engine CLI is retired and cannot start or control runs.",
  "Register this repository with the local Dapr service and use:",
  "  forge-launcher runtime repo add <path>",
  "  forge-launcher runtime restart",
  "  forge-launcher engine-run --repo <path> --yes",
  "Legacy workflow histories are not imported.",
].join("\n");

console.error(message);
process.exitCode = 1;
