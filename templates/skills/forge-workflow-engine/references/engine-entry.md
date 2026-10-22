# Workflow engine execution entry (retired)

The legacy in-process scheduler has no supported command entry point. Its
`workflow-engine` npm command has been removed, and direct invocation of
`scripts/cli.ts` fails closed without reading or writing workflow state.

For supported autonomous execution, register the repository with the local
Dapr service and use:

```bash
forge-launcher runtime repo add <path>
forge-launcher runtime restart
forge-launcher engine-run --repo <path> --yes
```

`forge-launcher resume` handles authoring and service runs; preserved
`docs/WORKFLOW-STATE.json` files are read-only history. Legacy workflow
histories and artifacts are not imported into Dapr. Follow the migration and
rollback procedure in [`docs/forge-launcher.md`](../../../docs/forge-launcher.md#cut-over-from-the-legacy-engine).
