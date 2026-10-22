---
name: workflow-orchestrator
description: "Retired legacy workflow-engine persona. Do not use for new execution."
mode: all
---

# Retired workflow orchestrator

This persona targets the retired in-process `forge-workflow-engine` scheduler.
Do not invoke its CLI, read `docs/WORKFLOW-STATE.json` as live run state, or
write legacy control files.

For supported autonomous execution, use the Dapr service through
`forge-launcher engine-run --repo <path> --yes` after registering the repository
with `forge-launcher runtime repo add <path>` and restarting the runtime.
Monitor and control runs with `forge-launcher service`. Legacy workflow
histories are not imported; follow the migration and rollback procedure in
`docs/forge-launcher.md`.
