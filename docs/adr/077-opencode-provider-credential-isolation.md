# ADR-077: Isolate OpenCode Provider Credentials Per Task

**Status:** Accepted
**Date:** 2026-10-21

## Context

OpenCode stores OAuth credentials in its own local data store. The service
deliberately gives each task an empty home, so the worker cannot depend on or
mount an operator's host auth directory. Some providers, including GitHub
Copilot, do not expose a simple API-key environment variable.

## Decision

- `OPENCODE_AUTH_JSON` is an explicit OpenCode harness grant containing one
  credential entry in the format emitted by `opencode auth export`.
- The OpenCode adapter writes the grant to a mode-0600 temporary file in the
  task's private temporary directory, owned by the task UID when applicable.
- It imports the entry with `opencode auth import --standalone` into the
  task's private OpenCode data store, then removes the temporary file before
  invoking the model.
- The credential JSON is removed from the environment passed to the OpenCode
  task process. No host auth directory is mounted, and validation commands
  receive no credentials.
- Provider authentication remains distinct from GitHub repository access;
  the grant is for model calls, not Git operations.

## Consequences

- Existing OpenCode provider logins can be handed off explicitly without
  granting the task access to the operator's full OpenCode profile.
- The selected task necessarily has access to the one provider credential it
  uses, as with other harness credentials. Keep grants restricted to trusted
  tasks and revoke them when no longer needed.
- OpenCode credential grants are limited to one exported credential entry per
  task attempt.
- Worker validation commands run in a separate empty home from the harness.
  They cannot read the task's imported OpenCode profile. The normal admission
  path and the resume path both use this boundary.
- Host execution is outside this decision. It uses the local CLI's normal
  authentication and does not enforce one-provider isolation. See
  [Harness credentials and execution boundaries](../harness-credentials.md#host-execution-warning).

## Threat model and limits

The worker boundary protects the credential from other tasks, repository
validation commands, the host auth store, runtime service tokens, and runtime
backups. It does not protect the credential from the selected task: the task
must authenticate to the provider and can exfiltrate the credential over the
network. Use least-privilege or short-lived provider credentials, revoke grants
after the run, and treat logs and task artifacts as potentially sensitive.

Local file permissions protect the grants file from other OS users. They do not
protect it from the same OS user or root. Use separate OS accounts or runtime
installations for distinct trust domains. See
[Harness credentials and execution boundaries](../harness-credentials.md) for
the full reader table and incident-response checklist.
