# Harness credentials and execution boundaries

MyForge gives a harness CLI only the provider credentials it needs to run a
task. The boundary depends on the executor:

- **Worker container** (default): the harness runs in the local runtime with
  per-task UID isolation and an explicit credential grant.
- **This computer** (host execution): the harness runs as your logged-in OS
  user with your normal CLI authentication. It is **not sandboxed**.

This page explains what each mode can read, how to grant credentials, and how
to limit the damage if one is exposed.

## Quick start

Worker execution needs an explicit grant for the selected harness:

```bash
# OpenCode with one exported provider credential
opencode auth export deepseek | jq -c . \
  | forge-launcher runtime harness grant opencode OPENCODE_AUTH_JSON

# Claude
forge-launcher runtime harness grant claude ANTHROPIC_API_KEY --from-env

# GitHub Copilot
forge-launcher runtime harness grant copilot COPILOT_GITHUB_TOKEN --from-env

forge-launcher runtime harness list     # names only, never values
forge-launcher runtime harness revoke opencode OPENCODE_AUTH_JSON
```

`OPENCODE_AUTH_JSON` must contain **exactly one** provider entry. The value is
the JSON array emitted by `opencode auth export`, not a single credential
object. The grant command rejects multi-provider exports before storing them,
and the worker verifies the imported profile again before the task starts.

Host execution does not use harness grants. It uses the local CLI's normal
login and configuration.

## Provider and model matching

The model prefix must match the credential's provider. The worker does not
rewrite model IDs or infer a provider from a key.

| Goal | Grant | Matching model prefix |
| --- | --- | --- |
| OpenCode with a DeepSeek API key | `OPENCODE_AUTH_JSON` = `opencode auth export deepseek` | `deepseek/...` |
| OpenCode with GitHub Copilot | `OPENCODE_AUTH_JSON` = one `github-copilot` entry | `github-copilot/...` |
| OpenCode with OpenAI | `OPENAI_API_KEY` | `openai/...` |
| OpenCode with Anthropic | `ANTHROPIC_API_KEY` | `anthropic/...` |
| OpenCode with OpenRouter | `OPENROUTER_API_KEY` | `openrouter/...` |
| Claude Code | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Claude's configured model |
| GitHub Copilot harness | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` | `github-copilot/...` |

Examples for DeepSeek:

```text
deepseek/deepseek-flash
deepseek/deepseek-v4-pro
```

`opencode/deepseek-v4.1-flash-free` uses the `opencode` provider, not the
DeepSeek integration. A DeepSeek grant does not authenticate that model. The
worker harness still requires at least one granted variable to be admitted, so
a free model may need a grant that it does not actually use.

`DEEPSEEK_API_KEY` is not an allowed OpenCode harness variable. Use
`OPENCODE_AUTH_JSON` with the DeepSeek export. The same applies to any provider
that is not listed in the OpenCode allowlist.

## Where the credential lives

Worker grants are stored in the local runtime data directory:

```text
<runtime-data>/harness-grants/grants.json
```

- The directory is owner-only (`0700`) and the file is owner-only (`0600`).
  The launcher rejects symlinks and files owned by another user and repairs a
  too-permissive mode.
- The file is mounted **read-only** into the worker at
  `/run/myforge/harness-grants/grants.json`.
- The worker reads the grants once per attempt and passes only the selected
  harness's variables.
- `OPENCODE_AUTH_JSON` is written to a `0600` temporary file in the task's
  private temporary directory, owned by the task UID. It is imported with
  `opencode auth import --standalone`, verified to contain exactly one
  provider, and removed before the model runs. The variable is also removed
  from the task process environment.
- Each worker task gets its own unprivileged UID, home, and workspace.
- Validation commands get a **separate empty home** and no credential
  environment variables, so a repository validation command cannot read the
  imported OpenCode profile.
- Runtime backups exclude the grants file, `runtime.env`, and host-runner
  capability material. A restored runtime needs the grants re-entered.

## What can read the credential

| Reader | Worker execution | Host execution |
| --- | --- | --- |
| The selected task | **Yes** — it must authenticate to the provider. It can also exfiltrate the credential over the network. | **Yes** — and it can read the host's normal CLI auth. |
| Other tasks | No — separate UID, home, and workspace. | **Yes** — same OS user and home. |
| Repository validation commands | No — separate home and no credential variables. | No — validation runs in the worker against the imported workspace, not on the host. |
| Worker root / service process | Yes — trusted runtime code. | Not applicable. |
| Host execution | Not applicable. | **Yes** — the task runs as your user. |
| Same local OS user or root | Yes — file permissions do not protect against the owner or root. | Yes. |
| Remote network | No direct access. The service and Console are loopback-only. | No direct access. |
| Runtime backup | No — grants and runtime secrets are excluded. | No. |
| Logs | Best-effort redaction. A task can print an arbitrary secret; treat logs as sensitive. | Best-effort redaction; the handoff and artifacts can still contain a secret. |

### Host execution warning

Host execution is intentionally unsandboxed (see
[ADR-081](adr/081-native-local-harness-execution-without-task-sandbox.md)). A
task running in this mode can read files available to your OS account,
including:

- `~/.local/share/opencode/auth.json` and other CLI auth stores;
- `<runtime-data>/runtime.env` (the service API token and database passwords);
- `<runtime-data>/host-runner-capabilities.json`;
- `~/.ssh`, cloud credential files, browser data, and shell configuration.

It can also use your SSH agent, cloud CLIs, container engine, and network
access if they are available to your account. Use host execution only for
repositories, prompts, and agent output you trust. Use the worker container
for untrusted work.

## Operational checklist

- Prefer **worker execution** for any repository or prompt you do not fully
  trust.
- Grant **one provider** per OpenCode task. Do not paste a full
  `opencode auth export`.
- Use a dedicated API key or account with the smallest scope and a spend
  limit. Prefer short-lived credentials where the provider supports them.
- Revoke the grant after the run when it is no longer needed:

  ```bash
  forge-launcher runtime harness revoke opencode OPENCODE_AUTH_JSON
  ```

- Keep `Log harness activity` off for tasks that may handle secrets. When it
  is on, harness stdout/stderr is written to `docs/forge.log`.
- Do not put credentials in task prompts, repository files, handoffs, or
  artifacts. The engine persists admitted handoffs and validation evidence.
- Keep the runtime data directory private. Use a separate OS account or a
  separate runtime installation for distinct trust domains; file permissions
  do not isolate processes running as the same user.
- Use full-disk encryption (LUKS, FileVault, or BitLocker) if you need
  protection from offline disk access. Encrypting the grants file with a key
  stored on the same machine does not stop the task or a same-user process.
- Monitor provider usage and audit logs for unexpected calls.

## If a credential is exposed

1. Revoke the harness grant immediately.
2. Rotate the provider credential at the provider, then grant the replacement.
   For OAuth providers, log out and re-authorize, and revoke the application
   session in the provider's security settings if needed.
3. If host execution was involved, assume the host CLI auth, the runtime API
   token, and runner capabilities may also be exposed. Rotate the runtime
   tokens with `forge-launcher runtime rotate-tokens`, rotate each runner
   capability with `forge-launcher runtime runner rotate <repository-id>`, and
   restart the runtime.
4. Review `docs/forge.log`, runtime logs, and provider audit logs. Treat
   any copied logs or artifacts as sensitive.
5. If the host account itself may be compromised, stop the runtime and rotate
   credentials from a clean session.

## FAQ

**Can I grant every configured provider at once?** No. OpenCode accepts one
provider entry per task. Use one grant per provider and select the matching
model.

**Does `OPENCODE_AUTH_JSON` grant Git access?** No. It authenticates model
calls only. Repository access is separate.

**Does host execution use the Console grant?** No. Host execution uses the
local CLI's normal login and does not enforce one-provider isolation.

**Can I use DeepSeek?** Yes, with `OPENCODE_AUTH_JSON` containing the DeepSeek
export and a `deepseek/...` model. You do not need a separate
`DEEPSEEK_API_KEY` grant.

**Why did a task fail with "no credentials"?** The selected worker harness has
no grant. Run `forge-launcher runtime harness grant <harness> <VARIABLE>` and
retry. The Console's Runtime view lists granted variable names.

**Why can the task still read its credential?** The task has to authenticate
to the provider. Isolation limits *which* credential it gets and prevents other
tasks and validation commands from reading it; it cannot prevent the task from
using the credential it was given.
