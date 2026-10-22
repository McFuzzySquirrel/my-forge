---
name: forge-workflow-engine
description: "Retired legacy scheduler reference. Do not use for new execution."
---

# Retired workflow-engine reference

The in-process `forge-workflow-engine` scheduler is retired for new runs.
Do not invoke its CLI, write `docs/WORKFLOW-STATE.json` or
`docs/engine-control.json`, or use its PID controls. This package remains in
the source tree only while legacy behavior tests and migration references are
being retired.

Use the Dapr execution service for supported runs:

1. Register the repository with `forge-launcher runtime repo add <path>`.
2. Restart the local runtime after registration.
3. Start or resume a run with `forge-launcher engine-run --repo <path> --yes`.
4. Monitor or control runs with `forge-launcher service`.

Legacy workflow history is not imported into Dapr. Preserve old state and Git
artifacts before cutover; follow the migration and rollback procedure in
[`docs/forge-launcher.md`](../../../docs/forge-launcher.md#cut-over-from-the-legacy-engine).
