# ADR-070: Local Operator Session and Sidecar Token

**Status:** Accepted  
**Date:** 2026-10-21

## Context

P5-05 hardens local access. ADR-068 requires a loopback-only local profile in
which access trusts the operating-system user. It must not need GitHub, `gh`,
Copilot, or harness logins. ADR-069 gave the service run API a bearer token.
Two gaps remained.

1. **The Console.** It already bound to `127.0.0.1` and required a per-server
   `X-Forge-Token` header on `POST` requests. But:
   - Reads, the event stream, and the page that embeds the token needed no
     credential.
   - `GET /api/token` returned the token to any caller.
   - `Host` was not checked, so a DNS-rebinding page could read the Console
     as same-origin and then act on it.
2. **The Dapr sidecar.** It accepted unauthenticated calls on the worker's
   network. Harness environments are allowlisted and never receive database
   or API secrets. Even so, any process in the worker container could reach
   `daprd:3500` and raise workflow events or read state.

## Decision

### Console operator session

- **Sign-in capability.** `forge-launcher console` prints a single-use
  capability URL, `/session?capability=…`, to its terminal. The browser it
  opens uses a separate capability. A capability carries 256 bits of
  randomness, expires after 10 minutes, and no more than five are outstanding.
- **Session cookie.** Exchanging a capability sets
  `forge_console_<port>=<session>; Path=/; HttpOnly; SameSite=Strict` and
  redirects to `/`. The cookie name includes the port because browsers do not
  isolate cookies by port. A session expires after 12 hours without use and
  when the Console process stops.
- **Every route needs a session** except the exchange: pages, static assets,
  the API, and the event stream. Without one, `/api/*` returns 401 JSON. Other
  routes return 401 HTML and print a fresh link to the terminal. The browser
  never receives a link, because a page that showed one would hand a session
  to anything able to load the URL.
- **Origin checks.** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`
  (421 otherwise). A request with any other `Origin` gets 403. `POST` requests
  still require `X-Forge-Token`, which is now delivered only inside the
  session-protected page. `/api/token` is removed.
- **Sign out.** The header's Sign out button calls
  `POST /api/session/logout`, which needs the session and `X-Forge-Token`. It
  revokes the session and expires the cookie.
- **Bind address.** The Console has no option to bind beyond loopback.

### Sidecar token

- The runtime generates a fifth installation secret, `DAPR_API_TOKEN`.
  Existing `runtime.env` files hold an ordered prefix of the secret list, and
  the missing secrets are appended atomically without changing the existing
  ones.
- Compose requires the token for both `daprd` and the worker. The Dapr SDK
  sends it automatically, and the worker's sidecar readiness probe sends it
  explicitly.
- `DAPR_*` and `MYFORGE_*` variables are forbidden in harness environments,
  whether inherited, passed through, or bound as credentials. Runtime
  diagnostics redact the token.
- `forge-launcher runtime rotate-tokens` replaces the service API token and
  `DAPR_API_TOKEN` atomically and keeps the database passwords. The new tokens
  take effect after `runtime stop` and `runtime start`.
- A deployment test fails if any Compose file publishes a port off loopback or
  drops the sidecar token requirement.

## Consequences

- Plain Console URLs and bookmarks show a sign-in page. Users open the link
  printed in the terminal. Tests and the screenshot tool sign in once per
  server.
- A process running as the same OS user can still read the terminal or the
  credential file. That matches the local trust boundary in ADR-068.
- PostgreSQL remains reachable on the worker network but needs passwords that
  harnesses never receive. Network-level isolation of task processes waits
  for the harness provisioning decision (P5-03), because only the stub harness
  runs in the worker today.
- A shared or non-loopback profile remains unqualified. Nothing in the local
  profile can bind beyond loopback.
