# ADR-089: Run-level timeouts and per-attempt harness activity

## Status

Accepted.

## Context

The Console can set a task timeout or set all task timeouts, which writes
`timeoutMs` into the compiled manifest. Those values already apply because the
manifest is snapshotted into the run. The separate default timeout and CLI
`--task-timeout-ms` were ignored by service runs, so the Console showed a note
that conflicted with the task editor's behavior.

Harness activity logging was also ignored. Worker output went only to the
service container's stdout, which the Console did not expose; host output was
visible only indirectly in the host-runner log.

## Decision

- Add `taskTimeoutMs` to service submission settings. It is the fallback for
  tasks without a manifest `timeoutMs`; a task-level value wins. The effective
  value extends the supervised attempt budget when it is larger than the
  service default.
- Add `logHarnessActivity` to service submission settings and pass it through
  the execution request to the harness adapters.
- Worker activity is written to a bounded, owner-only file under the runtime
  `activity/` directory, keyed by run, task and logical attempt. Host activity
  continues to the host-runner log.
- Expose worker activity through the authenticated service API and a Service
  runs task **Activity** action. The API verifies the run belongs to the
  requested repository before reading.
- Run settings are frozen at submission. The Console states that timeout and
  activity changes apply to the next run.

## Consequences

- The task timeout shown and edited in the Console now has a clear precedence:
  task, then run/default, then service budget.
- Operators can inspect opt-in worker activity without reading container
  stdout; host activity remains in the existing Runtime log.
- Activity can contain sensitive repository content and is therefore opt-in,
  bounded, and redacted; it is not committed to the repository.
