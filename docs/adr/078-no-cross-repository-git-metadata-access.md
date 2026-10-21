# No Cross-Repository Git Metadata Access

**Status:** Accepted
**Date:** 2026-10-21

Registered repositories are not a shared task trust domain: task UIDs must not
read source Git metadata from any registered repository, including the task's
own source or sibling repositories. Before listening, the service changes each
mounted `.git` root to owner-only mode and proves a task UID cannot read its
`HEAD` using the same `setpriv` identity and capability-dropping policy used by
task processes; it fails startup if the mount, permission change, service
access, zero-capability task identity, or task-UID denial cannot be verified.
The service owner retains access for Git integration.

This supersedes the shared-trust-domain acceptance in [ADR-075](075-security-boundary-review.md);
the cross-repository read is no longer accepted. The permission change tightens
the host `.git` directory to mode `0700` and remains after a repository is
unregistered; its owner retains normal Git access. Native macOS and Windows
Podman-machine mount semantics remain unqualified, and the runtime must fail
closed if their task-UID probe cannot prove denial. Linux rootless F11
qualification confirmed sibling metadata denial and successful service-side
integration.
