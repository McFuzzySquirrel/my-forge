# ADR-068: Local Deployment and Access Profiles

**Status:** Accepted  
**Date:** 2026-10-19

## Context

P4-GATE authorized P5, which moves the launcher and Console onto the Dapr
service. Two questions had to be settled first:

1. **Persistent database.** `tools/dapr-engine/compose.postgres.yaml` supplies a
   digest-pinned PostgreSQL with a loopback port (`127.0.0.1:55432`), but it is
   only the opt-in integration-test database. The qualification helper
   (`scripts/support/dapr-stack.ts`) builds a temporary stack. No persistent
   runtime that users can always start exists yet. Workflow state, application
   records, Scheduler state, artifacts, and Git checkpoint data each have their
   own durability needs, so PostgreSQL alone is not enough.
2. **Who is the user?** Repositories live on GitHub and collaborators share them.
   The question is whether the already-signed-in user is enough. Contract v1
   controls (`contract/v1/controls.ts`) require an authenticated trusted subject
   and an operator role for approvals, but no authentication exists yet. The
   current Console uses a loopback bind and a per-process `X-Forge-Token`.

ADR-066 requires private infrastructure ports, a separate persistence owner for
each store, and a separate qualification gate before hosted use.

## Decision

### Deployment

- The launcher distributes a **persistent local Podman Compose stack**
  (PostgreSQL, Dapr sidecar, Placement, Scheduler). Each store gets its own
  named volume, images and versions are pinned, and the stack has readiness
  ordering, restart policy, and resource limits. Stop and recreate keep data;
  reset is a separate confirmed action.
- The current infrastructure package declares separate PostgreSQL and
  Scheduler volumes. Any separate artifact volume is added with the runtime
  service that owns artifact persistence; the Compose package must not declare
  an unused volume as evidence of durable artifact storage.
- PostgreSQL is **private by default**. An optional host-tools override
  publishes only `127.0.0.1:${POSTGRES_PORT:-55432}:5432`. This is the single
  explicit exception to ADR-066's private-port rule, and it stays loopback-only.
  If the port is taken, Forge reports an error instead of choosing another port.
  Containers connect by service DNS.
- Dapr-owned state and application-owned tables use separate databases or
  schemas with narrowly scoped roles. Credentials are generated once, stored in
  protected untracked installation storage, and reused.
- `compose.postgres.yaml` remains the separate **test** database with its own
  volume; user runtime data is never attached to it, nor it to user data.

### Access profiles

- **Local (P5).** A single user on one machine. Forge trusts the local OS
  account through a protected local operator session: a one-time bootstrap
  capability is exchanged for an expiring browser session. Reads, artifacts,
  event streams, and controls are authenticated, with Host, Origin, and CSRF checks. No
  GitHub, `gh`, Copilot, or GitHub App login is needed, and authentication is
  independent of the selected harness. **Standalone use without collaborators
  is first-class.** This does not isolate Forge from malicious processes
  running as the same OS user.
- **Shared (P8 only).** A Forge server used by several collaborators.
  An ambient login is **not** sufficient: a browser GitHub cookie, local `gh`
  account, harness account, or Git author configuration does not prove identity
  to a remote Forge server. It also does not establish what that person may do
  in a repository. Collaborators use **GitHub App user sign-in**; an existing
  browser GitHub session only shortens the redirect. Authorization requires
  both that the app is installed on the repository and that the user currently
  has permission there. Read or triage may view; write, maintain, or admin may
  submit, control, and approve. Host administration is configured separately.
  Ownership of the app registration is decided in P8, with operator-registered
  per deployment as the initial proposal.
- Forge does not implement its own passwords. Git remote and model-provider
  credentials remain separate from Forge sessions and are never forwarded to
  harnesses together with session secrets.
- Binding to a non-loopback address fails unless a qualified shared profile is
  configured.

## Consequences

- Single-user local operation needs no GitHub connectivity or app registration.
- P5-01, P5-02/P5-05, and P8-02 in [plan.md](../../plan.md) carry these
  decisions; the canonical requirements are in
  [the local deployment and access feature](../features/dapr-local-deployment-access.md).
- A shared deployment does not imply public database access, high availability,
  clean-host recovery, or safety for untrusted repositories; those remain P6/P8
  qualification work.
- Reading execution logs may expose repository content, so shared read access
  requires scoped secret redaction, not just hidden mutation buttons.
