# Research: Can GitHub-hosted Actions runners qualify P6-05 macOS/Windows Podman-machine support?

**Date:** 2026-10-21
**Status:** Findings; recommends developer/self-hosted qualification over GitHub-hosted runners
**Related:** [P6-05 evidence](../../plan.md#p6-05-platform-and-harness-evidence--2026-10-21),
[`dapr-workflow-and-agents.md`](./dapr-workflow-and-agents.md) (cites Podman machine and rootless
limitations already)

## Question

P6-05 still needs macOS and Windows Podman-machine qualification (networking, credentials,
mounts, path translation, watchers, performance — `plan.md:410-420`). Could a GitHub Actions
workflow using GitHub-hosted `macos-*` / `windows-*` runners produce credible qualification
evidence for this, instead of (or ahead of) a developer-hosted machine? This note only researches
feasibility; it changes no workflow files and runs no Actions jobs.

## What Podman machine requires, per Podman's own docs

Podman's own installation guide states plainly that on both desktop platforms Podman does not run
containers directly — it always provisions a VM:

> "On Mac, each Podman machine is backed by a virtual machine... remotely communicates with the
> `podman` service running in the Machine VM."
> "On Windows, each Podman machine is backed by a virtualized Windows Subsystem for Linux (WSLv2)
> distribution."
— [Podman Installation Instructions, "Installing on Mac & Windows"](https://podman.io/docs/installation#installing-on-mac--windows)

The `podman-machine` man page confirms the provider matrix and that `podman machine` is
rootless-only:

> "Podman on MacOS and Windows requires a virtual machine... All `podman machine` commands are
> rootless only."
>
> | Platform | Provider |
> |---|---|
> | MacOS | libkrun* (default), applehv |
> | Windows | wsl* (default), hyperv |
— [`podman-machine(1)`](https://docs.podman.io/en/latest/markdown/podman-machine.1.html)

So "qualify Podman-machine on macOS/Windows" is inherently "qualify a nested VM (libkrun/applehv
on macOS; WSL2/Hyper-V on Windows) running inside whatever VM already hosts the test."

## What GitHub-hosted runners are, per GitHub's own docs

GitHub-hosted `macos-*` and `windows-*` runners are themselves VMs:

> "With the exception of single-CPU runners, each GitHub-hosted runner is a new virtual machine
> (VM) hosted by GitHub... GitHub hosts Linux and Windows runners on virtual machines in Microsoft
> Azure... GitHub hosts macOS runners in Azure data centers."
— [GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
("Overview of GitHub-hosted runners", "Cloud hosts used by GitHub-hosted runners")

The same page states GitHub's general policy on a second layer of virtualization inside that VM:

> "While nested virtualization is technically possible while using runners, it is not officially
> supported. Any use of nested VMs is experimental and done at your own risk, we offer no
> guarantees regarding stability, performance, or compatibility."
— [GitHub-hosted runners, "Preinstalled software for GitHub-owned images"](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)

For Apple-silicon (arm64) macOS runners specifically, GitHub's hosted-runner reference is explicit
and unconditional, not merely a disclaimer:

> "Nested-virtualization is not supported due to the limitation of Apple's Virtualization
> Framework."
— [GitHub-hosted runners reference, "Limitations for arm64 macOS runners"](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#limitations-for-arm64-macos-runners)

`macos-latest` / `macos-14` / `macos-15` / `macos-26` all resolve to arm64 images today (see the
same reference page's runner table), so the default hosted macOS runner is exactly the one GitHub
says cannot nest-virtualize. Intel macOS runners (`macos-15-intel`, `macos-26-intel`) exist but are
not the default and GitHub does not publish an equivalent explicit nested-virtualization guarantee
for them — the general "not officially supported... experimental" statement above is the only
documented position for that tier.

For Windows, GitHub's images do ship WSL2 (confirmed in the current `windows-2025` image notes:
"Windows Subsystem for Linux (Default, WSLv2): 3.0.3.0", per the image's own published software
list — [`actions/runner-images` Windows2025 readme](https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md)).
Presence of the WSL2 package is not the same as a working nested hypervisor: WSL2 and Hyper-V both
depend on the CPU virtualization extensions being exposed to the guest, which is exactly the
capability GitHub's "nested virtualization... not officially supported... experimental" language
puts in question for the underlying Azure VM. GitHub's public docs do not state, one way or the
other, whether Windows runners expose working nested Hyper-V — this is a documented gap (see
Unresolved risks).

## Why this matters for Podman specifically

Podman's default providers are the nested hypervisor in both cases:

- macOS default `libkrun` and the alternative `applehv` both need a functioning virtualization
  layer under macOS — `applehv` explicitly wraps Apple's Virtualization Framework, which is the
  exact framework GitHub says cannot nest-virtualize on its arm64 runners.
- Windows default `wsl` is "backed by a virtualized Windows Subsystem for Linux (WSLv2)
  distribution" per Podman's own install docs (quoted above) — i.e., a second-level VM under
  Windows, same nested-virtualization dependency.

So on the default hosted images for both platforms, `podman machine init`/`start` is attempting
exactly the operation GitHub documents as unsupported (arm64 macOS) or undocumented and
architecturally equivalent to an unsupported operation (Windows WSL2/Hyper-V backend).

## Recommended feasibility approach

1. **Do not treat GitHub-hosted `macos-*`/`windows-*` runners as the qualification environment for
   P6-05.** Use them, if at all, only as a cheap, automatable *smoke check* that fails fast and
   loud, not as the evidence source plan.md requires.
2. **A hosted-runner workflow could still be useful as a negative/triage signal**: a job that runs
   `podman machine init && podman machine start` and records whether it succeeds, on both
   `macos-15-intel` (Intel, no documented nested-virt denial) and the default arm64 `macos-latest`,
   plus `windows-latest`. A pass would be informative (though per GitHub's "experimental, no
   guarantees" language, still not citable as durable supported behavior); a failure would confirm
   the predicted nested-virtualization block without consuming developer time.
3. **Primary qualification evidence must come from genuine macOS and Windows hosts** — a developer
   workstation, a GitHub-hosted *self-hosted* runner registered on such a host, or an
   Azure/other cloud VM with real (non-nested) hardware virtualization exposed — mirroring exactly
   how the existing Linux rootless evidence in `plan.md:862-878` was produced (real host, not a
   CI-only approximation).
4. If a larger/custom-image GitHub-hosted tier is ever considered, re-check GitHub's larger-runner
   docs for an explicit nested-virtualization guarantee before relying on it; the arm64 macOS
   denial above is the only unconditional statement found during this research, so absence of a
   similar statement elsewhere should not be read as implicit support.

## What would still be testable on a hosted runner (if attempted)

- `podman machine init`/`start` success/failure and the exact error text, as a documented
  reproduction of the nested-virtualization gap.
- CLI/package presence checks (Podman version, WSL version, Xcode/virtualization entitlements)
  that don't require the machine to actually start.
- Negative-path behavior of MyForge's own tooling when Podman machine is unavailable (e.g., does
  the launcher fail with a clear error rather than hanging) — useful defect-hardening even though
  it is not platform *qualification* evidence.

## What is not testable / unresolved risks

- **No official GitHub statement on Windows nested Hyper-V/WSL2 functionality inside hosted
  runners.** The Windows image ships WSL2 (per the runner-images readme), but GitHub's docs do not
  confirm the underlying Azure VM exposes working nested virtualization to it. This must be
  verified empirically (and only as the triage smoke test in item 2 above, not as the qualification
  record) before any claim is made either way.
- **Intel macOS hosted runners (`macos-15-intel`, `macos-26-intel`) have no explicit GitHub
  statement on nested virtualization support**, unlike the arm64 tier's unconditional denial.
  Silence is not evidence of support; GitHub's blanket "experimental... no guarantees" language
  still applies.
- **Networking, credentials, mounts, path translation, and watcher behavior** (the actual P6-05
  scope per `plan.md:411`) cannot be meaningfully qualified on a runner where the machine itself
  may not start — these require the VM to come up before they're even exercisable, so a
  hosted-runner attempt is blocked upstream of the real test matrix in the worst case, and even in
  the best case, GitHub's own "no guarantees regarding stability, performance, or compatibility"
  disclaimer undermines using the results as durable support evidence.
- **Performance evidence is explicitly disclaimed.** GitHub says nested VM use offers "no
  guarantees regarding stability, performance, or compatibility," so hosted-runner timings cannot
  stand in for the performance qualification `plan.md:412` asks for, even if the machine happens to
  start.

## Conclusion: hosted vs. developer-hosted runners as evidence sources

GitHub-hosted macOS and Windows runners are **not a credible source of P6-05 qualification
evidence** for Podman-machine runtime support:

- They do not meet Podman's own stated requirement (a working nested VM) with any documented
  guarantee on the default macOS tier (arm64), where GitHub explicitly says nested virtualization
  does not work.
- Where GitHub is merely silent (Windows, Intel macOS) rather than explicit, its blanket
  nested-virtualization disclaimer ("experimental... no guarantees") still applies, so a pass
  there would be anecdotal, not a basis for closing P6-05.
- Even a pass would only establish that `podman machine` starts under one specific, versioned,
  Azure-hosted, GitHub-maintained image — not the credentials/mounts/path-translation/watcher
  behavior P6-05 requires, and not with any durability guarantee across future image updates.

A genuine developer-hosted (or otherwise non-nested, real-hardware) macOS and Windows machine
remains the only approach that can produce evidence comparable in kind to the existing Linux
rootless evidence already recorded for P6-05 in `plan.md:862-878`. GitHub-hosted runners can, at
most, provide an early, disposable smoke signal that nested Podman-machine startup fails or
succeeds on a specific image — useful for triage, not for qualification sign-off.

## Sources

- [Podman Installation Instructions — "Installing on Mac & Windows"](https://podman.io/docs/installation#installing-on-mac--windows)
- [`podman-machine(1)`](https://docs.podman.io/en/latest/markdown/podman-machine.1.html)
- [`podman-machine-init(1)`](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html)
- [GitHub Docs — GitHub-hosted runners (overview, cloud hosts, nested-virtualization disclaimer)](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
- [GitHub Docs — GitHub-hosted runners reference (runner table; arm64 macOS nested-virtualization limitation)](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [`actions/runner-images` Windows2025 readme (WSL2 present in image)](https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md)
