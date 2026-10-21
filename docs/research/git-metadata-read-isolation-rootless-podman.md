# Research: Is owner-only chmod + a real task-UID access probe a defensible Linux
# fix for cross-repository Git metadata read isolation?

**Date:** 2026-10-21
**Status:** Findings; Linux-only, confirms the approach with caveats
**Related:** [ADR-076](../adr/076-task-process-privilege-isolation.md) residual risk
("the live probe confirms it can read their metadata and objects" — every registered
repository's `.git` is bind-mounted into the same worker container and the unprivileged
task UID can read, though not write, every other repository's Git metadata).

## Question

ADR-076 gives each task attempt a distinct UID/GID (20,000–60,000) and runs harness and
validation commands through `setpriv` with that identity. The residual risk is that the
worker still bind-mounts every registered repository's `.git` directory into the same
container, and the task UID can read (not write) metadata and objects belonging to other
repositories. The selected fix is to apply owner-only mode `0700` to each source `.git`
root while keeping its existing service-owner mapping, then prove a real task UID cannot
read the Git `HEAD` (not merely inspect mode bits). This note establishes whether that
is a defensible Linux implementation and what caveats must be recorded. **Scope: Linux
rootless Podman only — macOS and Windows (Podman machine, WSL2/Hyper-V/libkrun) are
explicitly out of scope and not evaluated here; see
[`p6-05-hosted-runner-feasibility.md`](./p6-05-hosted-runner-feasibility.md) for the
macOS/Windows virtualization angle.**

## 1. Rootless Podman bind mounts and the UID/GID visible in the container

A rootless Podman container's root user namespace maps host UIDs into the container via
`/etc/subuid`/`/etc/subgid` ranges, as the kernel's `user_namespaces(7)` mechanism
describes generally:

> "User namespaces isolate security-related identifiers and attributes, in particular,
> user IDs and group IDs... A process's user and group IDs can be different inside and
> outside a user namespace."
> "When a process accesses a file, its user and group IDs are mapped into the initial
> user namespace for the purpose of permission checking and assigning IDs when creating
> a file. When a process retrieves file user and group IDs via `stat(2)`, the IDs are
> mapped in the opposite direction, to produce values relative to the process user and
> group ID mappings."
— [`user_namespaces(7)`](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)

Podman's own "shortcomings of rootless Podman" list confirms the practical consequence —
a standard rootless UID/GID range is bounded (65,536 IDs by default) and higher host IDs
simply fall outside the mapping:

> "A standard rootless configuration only gives containers access to 65536 UIDs and
> GIDs — images with higher UIDs and GIDs cannot be used."
— [`rootless.md`, "Shortcomings of Rootless Podman"](https://github.com/containers/podman/blob/main/rootless.md)

Podman's troubleshooting guide documents directly what `ls -l` on the host shows for
files a rootless container creates: the raw subordinate-ID number, not the invoking
user's name, because the file is really owned (on-disk) by the subuid-mapped ID, and
confirms this round-trips through a `chmod` performed from inside the container:

> "$ mkdir dir1; chmod 777 dir1
> $ podman run --rm -v ./dir1:/dir1:Z --user 2003:2003 docker.io/library/ubuntu
>   bash -c \"touch /dir1/a; chmod 600 /dir1/a\"
> $ ls -l dir1/a
> -rw-------. 1 102002 102002 0 Jan 19 19:35 dir1/a
> $ less dir1/a
> less: dir1/a: Permission denied"
— [`troubleshooting.md`, "34) Container creates a file that is not owned by the user's
regular UID"](https://github.com/containers/podman/blob/main/troubleshooting.md)

This is primary-source confirmation of two separate claims the implementation depends
on: (a) `chmod` executed by a process inside a rootless container against a bind-mounted
host path is not a container-local fiction — it changes the real on-disk mode bits, and
the restricted mode (`0600`/`0700`-class) is enforced by the host kernel against the
real (subuid-mapped) owner; and (b) the owning user themselves (`102002` in the example,
mapped from the container's UID 2003) is subsequently denied access by their *own* shell
once the mode is owner-only and the invoking shell's UID does not match the mapped owner.

The same troubleshooting entry gives the formula Podman itself recommends for translating
between the container-visible UID and the host-visible subuid-mapped UID:

> "`$ lowest_subuid=$(podman info --format \"{{ (index .Host.IDMappings.UIDMap 1).HostID
> }}\")` ... `$ uid=$(( $uid_from_ls - $lowest_subuid + 1))`"
— [`troubleshooting.md`, "34) ..."](https://github.com/containers/podman/blob/main/troubleshooting.md)

**Implication for MyForge:** the source `.git` remains owned by the host repository
owner, which maps to the root/service owner inside the rootless worker. The worker's
per-attempt task UIDs (20,000–60,000, per ADR-076) are distinct mapped IDs. Applying
`chmod 0700` from the service therefore leaves the service as owner while preventing
task UIDs from traversing the Git root. The access probe is still necessary because
host ownership mappings can differ or fail.

## 2. Does `chmod` from a rootless container actually restrict a bind-mounted host path?

Yes, with the access-control rule for `chmod(2)` applying at the real (mapped) owner:

> "The effective UID of the calling process must match the owner of the file, or the
> process must be privileged (Linux: it must have the `CAP_FOWNER` capability)."
— [`chmod(2)`](https://man7.org/linux/man-pages/man2/chmod.2.html)

Inside a user namespace, whether a process's `root`-like identity can use capabilities
such as `CAP_FOWNER` to chmod a file it does not literally own is itself gated by whether
the file's owning IDs are mapped at all in that namespace:

> "Within a user namespace, these capabilities allow a process to bypass the rules if
> the process has the relevant capability over the file, meaning that: the process has
> the relevant effective capability in its user namespace; and the file's user ID and
> group ID both have valid mappings in the user namespace."
> "The `CAP_FOWNER` capability is treated somewhat exceptionally: it allows a process to
> bypass the corresponding rules so long as at least the file's user ID has a mapping in
> the user namespace."
— [`user_namespaces(7)`, "Operation of file-related
capabilities"](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)

Podman's rootless tutorial works through the practical corollary for bind-mount sources
(the directory being mounted in, analogous to the `.git` directory here) with worked
examples at three mode/ownership combinations:

> "Inside the user namespace the process setting up the mount is `root`, but
> `CAP_DAC_OVERRIDE` only bypasses a file's mode when that file's user ID and group ID
> both have valid mappings in the namespace... A directory owned by an unmapped ID is
> reported with the overflow ID, 65534 by default, and nothing overrides its mode."
>
> "# parent mode 755, owned by root: the mode already allows it, mapping never comes up
> host$ podman run --rm -v /tmp/open/child:/mnt alpine echo ok
> ok
> # parent mode 700, owned by root: root is not mapped, so nothing overrides the mode
> host$ podman run --rm -v /tmp/private/child:/mnt alpine echo ok
> Error: statfs /tmp/private/child: permission denied
> # parent mode 700, owned by 100999, which the range maps to UID 1000 in the namespace
> host$ podman run --rm -v /tmp/mapped/child:/mnt alpine echo ok
> ok"
— [`docs/tutorials/rootless_tutorial.md`, "Permission denied on a bind-mount
source"](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)

**Implication:** an owner-only (`0700`) mode on a bind-mounted `.git` directory is
enforced by the real kernel permission check against the real (subuid-mapped) owner.
The rootless worker's service identity retains owner access when the repository owner
is mapped, while distinct task UIDs do not gain access merely because they run inside
the same container user namespace. The startup probe catches mapping or filesystem
behavior that does not match this expectation.

## 3. Limits and caveats on probing access "as a different container UID"

### 3.1 `access(2)`/`faccessat` checks the *real* UID, not necessarily the one you expect, and is not a safe substitute for the real operation

> "The check is done using the calling process's *real* UID and GID, rather than the
> effective IDs as is done when actually attempting an operation (e.g., `open(2)`) on the
> file... This allows set-user-ID programs and capability-endowed programs to easily
> determine the invoking user's authority. In other words, `access()` does not answer
> the 'can I read/write/execute this file?' question."
> "If the calling process is privileged (i.e., its real UID is zero), then an `X_OK`
> check is successful for a regular file if execute permission is enabled for any of the
> file owner, group, or other."
— [`access(2)`](https://man7.org/linux/man-pages/man2/access.2.html)

**Caveat to record:** a probe that merely calls `access()`/`faccessat()` from a
`root`-identity process (even one later going to `setpriv` to a task UID) must be run
*after* the UID switch, with the real UID actually set to the task UID — otherwise the
"privileged" branch of `access()`'s own rule can make the probe meaningless. The
qualification approach described in ADR-076 ("live probe confirmed... unreadable
grants.json; failed writes to the source repository's `.git/hooks`") is sounder than a
bare `access()` syscall because it actually attempts the real operation (open/read/write)
as the task UID via `setpriv`, which is the only way to get a result consistent with
what the task process will actually experience — `access()`'s own man page warns it
answers a different, narrower question and is a known TOCTOU hazard between the check
and the later real operation.

### 3.2 `setpriv` changes real/effective UID but does not by itself drop capabilities

> "Setting a `uid` or `gid` does not change capabilities, although the exec call at the
> end might change capabilities. This means that, if you are root, you probably want to
> do something like: `setpriv --reuid=1000 --regid=1000 --inh-caps=-all...`"
— [`setpriv(1)`](https://man7.org/linux/man-pages/man1/setpriv.1.html)

**Caveat to record:** a probe (or the task process itself) launched via `setpriv` must
explicitly drop capabilities (e.g. `--inh-caps=-all` and an empty/trimmed bounding set),
not merely set the UID/GID, or residual capabilities such as `CAP_DAC_OVERRIDE`/
`CAP_DAC_READ_SEARCH`/`CAP_FOWNER` carried through `execve(2)` from a privileged
inheritable set could let the "probe" succeed for reasons that have nothing to do with
the file's owner-only mode — producing a false negative for the isolation property being
tested. ADR-076 already requires "cleared supplementary groups" via `setpriv`; this is
the equivalent requirement for capability sets, and should be verified (e.g. via
`setpriv --dump` or `getpcaps` on the resulting process) rather than assumed.

### 3.3 Capability bypass is gated by whether the file's owner is *mapped*, not by an unconditional "root always wins" rule

As shown in §2, `CAP_DAC_OVERRIDE`/`CAP_FOWNER` only bypass a restrictive mode when the
file's owning UID (and, except for `CAP_FOWNER`, GID) has a valid mapping in the acting
process's user namespace (`user_namespaces(7)`, "Operation of file-related
capabilities"). **Caveat to record:** if a repository's `.git` is (mis)configured so its
owning UID falls *outside* the worker's configured subuid range, its ownership will
present as the overflow UID (65534 by default) to every process in the container
regardless of real host ownership, and the restrictive mode will deny access to
everyone including the intended owner — a misconfiguration failure mode, not a security
hole, but one that should produce a clear, loud error during the isolation setup/probe
rather than a silent "probe passed" result for the wrong reason. The overflow-UID value
itself is documented as configurable via `/proc/sys/kernel/overflowuid`
(`user_namespaces(7)`, "Unmapped user and group IDs").

### 3.4 `keep-id` and UID-translation only change what UID is seen in the container, not which host IDs the user namespace maps

> "`podman unshare ls -ldn` on the parent shows which case you are in: an owner of 65534
> there means the ID is not mapped. `--userns=keep-id` does not change this, it changes
> which UID you are inside the container rather than which host IDs the namespace maps."
— [`docs/tutorials/rootless_tutorial.md`, "Permission denied on a bind-mount
source"](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)

**Caveat to record:** verifying isolation by inspecting UIDs/mode bits as reported
*inside* the container (`ls -l`, `stat`) is necessary but not sufficient — the
authoritative check is the live access attempt as the real task UID (as ADR-076 already
does), because the in-container view can look correct while the underlying host mapping
is wrong, and vice versa.

## 4. Summary answer to the bounded objective

**Owner-only `chmod` plus a real task-UID access probe is a defensible Linux
implementation**, on the following evidentiary basis:

1. `chmod` issued from inside a rootless Podman container against a bind-mounted host
   path is real and host-enforced (§1, §2) — Podman's own troubleshooting doc shows the
   restrictive mode denying even the invoking host user's own later `less` read attempt.
2. The kernel's permission check for that restrictive mode is bypassed by capabilities
   like `CAP_DAC_OVERRIDE`/`CAP_FOWNER` only when the file's owning ID is mapped into
   the acting process's user namespace (§2) — this is the mechanism, not an assumption,
   and it does hold for IDs inside the worker's configured subuid range, which is the
   normal case for MyForge's 20,000–60,000 task-UID allocation.
3. A probe is only trustworthy if it (a) performs the real operation (open/read/write)
   rather than relying on `access()`/`faccessat()`'s narrower, real-UID-based semantics
   (§3.1), and (b) runs with both UID *and* capabilities actually dropped to the task
   identity, not UID alone (§3.2) — both are achievable with `setpriv` but require
   explicit capability-dropping flags and an independent verification step, matching
   what ADR-076's existing live-probe language already does for the grants file and
   source-repository write checks.

**Caveats that must be recorded alongside any isolation change:**
- Misconfigured ownership outside the subuid range produces a universally-denying
  overflow UID, not a working/mapped owner — treat an unexpected "probe passed because
  nobody can read it, including the owner" result as a setup failure, not success.
- `access()`-style checks are not equivalent to, and must not replace, an actual
  open/read attempt as the real task UID.
- This entire analysis is Linux/user-namespace-specific; it does not generalize to
  Podman machine (macOS/Windows), which runs inside a different VM/kernel boundary and
  was intentionally excluded from this note (see Related).

## MyForge implementation follow-up

The implementation uses one shared `taskProcessPrivilegeArgs` policy for both
task execution and the service's startup access probe. That policy switches
UID/GID, clears supplementary groups, sets no-new-privileges, and drops
bounding, inheritable, and ambient capabilities; see
[`isolation.ts`](../../tools/dapr-engine/execution/isolation.ts) and the
[harness runner](../../tools/dapr-engine/execution/harness/run.ts). The startup
probe confirms the capability sets are empty in `/proc/self/status` before it
attempts a real read of the mounted Git `HEAD`; see
[`repository-git-boundary.ts`](../../tools/dapr-engine/service/repository-git-boundary.ts).
The live F11 qualification also checks the task's capability state and verifies
that a sibling repository's `HEAD` is unreadable while service-side integration
succeeds; see
[`failures.ts`](../../tools/runtime-qualification/src/failures.ts).

## Sources consulted (primary only)

- [`user_namespaces(7)`](https://man7.org/linux/man-pages/man7/user_namespaces.7.html) —
  Linux man-pages project
- [`chmod(2)`](https://man7.org/linux/man-pages/man2/chmod.2.html) — Linux man-pages
  project
- [`access(2)`](https://man7.org/linux/man-pages/man2/access.2.html) — Linux man-pages
  project
- [`setpriv(1)`](https://man7.org/linux/man-pages/man1/setpriv.1.html) — util-linux,
  Linux man-pages project
- [`containers/podman: rootless.md`, "Shortcomings of Rootless
  Podman"](https://github.com/containers/podman/blob/main/rootless.md)
- [`containers/podman: docs/tutorials/rootless_tutorial.md`, "Permission denied on a
  bind-mount
  source"](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
- [`containers/podman: troubleshooting.md`, "34) Container creates a file that is not
  owned by the user's regular
  UID"](https://github.com/containers/podman/blob/main/troubleshooting.md)
- [`containers/podman: docs/source/markdown/options/userns.container.md`](https://github.com/containers/podman/blob/main/docs/source/markdown/options/userns.container.md)
  — `--userns` key/mapping table (`keep-id` semantics)

## Gaps / not researched (out of scope per objective)

- macOS/Windows Podman-machine (libkrun/applehv/WSL2/Hyper-V) ownership and permission
  semantics — explicitly out of scope; see `p6-05-hosted-runner-feasibility.md` for the
  separate virtualization-feasibility angle on those platforms.
- SELinux/AppArmor label interactions with bind-mounted `.git` directories (`:Z`/`:z`
  relabeling) were not investigated; they are an orthogonal MAC layer on top of the DAC
  mechanism analyzed here and could independently affect access even where DAC mode bits
  are correct.
- Filesystem-specific edge cases (NFS/overlay/fuse-overlayfs semantics for `chmod` on a
  bind-mount source living on a network filesystem) were not investigated beyond the
  general rootless shortcoming that rootless Podman "does not work on NFS or parallel
  filesystem homedirs" per `rootless.md`.
