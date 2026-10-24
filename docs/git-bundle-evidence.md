# Git bundle evidence

The Console's **Evidence** view can download a task's **Git bundle**. This page
explains what that file is, why MyForge produces it, and when an operator would
actually use it.

## Short answer

A Git bundle is **not just a convenience download**. It is the checkpoint's
portable Git object set and, during execution, the transport that carries an
isolated task result into the registered repository. MyForge also keeps it as
durable, verifiable evidence.

You do not need it for a normal successful run: the integrated
`forge/<branch>` commit is the canonical result. Download the bundle when you
need to inspect, reconstruct, recover, or audit the exact task state.

## What the file contains

MyForge captures a checkpoint after a task passes its gates and validation but
before it is integrated into the target branch. During capture it:

1. Writes the task workspace to a Git tree using the task's base revision as the
   starting point.
2. Creates a result commit whose parent is that base revision.
3. Creates a temporary bare repository that borrows the workspace's Git objects.
4. Points `refs/heads/checkpoint` at the result commit and writes a bundle from
   that repository.
5. Publishes the bundle as a content-addressed artifact and records it in the
   task's completion record.

The result is a normal Git bundle containing the result commit, the base
history reachable from it, and the trees and blobs needed to reconstruct the
task state. It is readable with standard Git; MyForge is not required to open
it.

The evidence record keeps three related artifacts:

| Artifact | Contains | Typical use |
|---|---|---|
| **Work artifact** | Structured task result, summary, handoff and output metadata | Understand what the task did and give context to dependants |
| **Validation artifact** | Validation commands, results and the completion digest | Prove which checks ran and what they returned |
| **Git bundle** | The actual Git commit, tree and objects | Inspect exact code, integrate or reconstruct, recover, audit |

The bundle is the only one of the three that can reproduce the code state
byte-for-byte.

## Why MyForge keeps it

### 1. It transports the task result out of the disposable workspace

Worker and host executions do not run in the registered repository checkout.
They run in temporary workspaces or disposable clones and produce a commit
there. Before integration, the engine imports the checkpoint bundle into the
target repository and fetches its `refs/heads/checkpoint` ref. The repository
integration authority can then advance `forge/<branch>` to the recorded result
commit.

Without the bundle, the commit exists only in a workspace that may already be
scheduled for deletion.

### 2. It supports rebasing and retries

If the target branch moves while a task is running, the engine cannot simply
apply the original base. It imports the bundle and cherry-picks the task's
result commit onto the new head. The bundle preserves the exact commit and
object graph needed for that operation.

### 3. It enables exact workspace reconstruction

The checkpoint reconstructor can verify the bundle, fetch it into a fresh
repository, check out the base revision, restore the recorded result tree, and
verify the declared Git objects. This is the path for rebuilding a task
workspace for revalidation, replay, or a later qualification gate without
depending on the original temporary workspace.

### 4. It is durable provenance and integrity evidence

The completion ledger records the result commit, base revision, checkpoint
digest, validation artifact and bundle artifact. The bundle plus its SHA-256
and declared Git object IDs lets an operator verify that the evidence refers to
the exact commit and tree the engine accepted. A missing, corrupt, or
mismatched bundle fails closed rather than silently producing incomplete
evidence.

### 5. It is portable

A bundle can be inspected on another machine without the original repository,
runtime database, or workspace. That makes it useful for debugging, review,
backup, or incident response.

## When to download it

| Scenario | Why the bundle helps |
|---|---|
| **You want the exact task diff** | Inspect the checkpoint commit and tree instead of relying on a branch that may have moved or been merged. |
| **Integration or rebase failed** | Confirm the expected commit and objects exist, and see what the engine was trying to integrate. |
| **You need to reproduce a checkpoint** | Reconstruct the workspace and rerun validation or inspection. |
| **You are auditing a completed task** | Compare the evidence record's commit and digest with a real Git object graph. |
| **You are moving evidence to another machine** | Take a single-file snapshot of the task's Git state without copying the runtime stores. |
| **A workspace or clone is gone** | Recover the task result from the durable bundle. |

A failed attempt that never reached checkpoint capture has no bundle. The
Evidence view reports missing artifacts explicitly; it does not synthesize them.

## When you do not need it

- **The run completed normally.** Use the integrated commit on the build branch
  and the work/validation artifacts for the explanation. The bundle is
  additional evidence.
- **You want a full backup.** A bundle is not a backup of PostgreSQL, run
  status, credentials, logs, or every branch. Use the runtime backup process for
  that.
- **You want to share evidence casually.** A bundle can contain source code and
  any committed secrets. Treat it as sensitive runtime data.
- **You only need to read the summary.** The work and validation artifacts are
  smaller and easier to inspect.

## Inspecting a downloaded bundle

The Console downloads the artifact as `<artifactId>.bundle`. Standard Git can
verify and open it:

```bash
# Validate the bundle and list its refs.
git bundle verify <artifactId>.bundle
git bundle list-heads <artifactId>.bundle

# Clone the checkpoint into a temporary directory.
git clone <artifactId>.bundle checkpoint
cd checkpoint
git log --oneline --decorate -n 5
git show --stat HEAD
git diff HEAD^ HEAD
```

To fetch the checkpoint into an existing repository instead:

```bash
git fetch <artifactId>.bundle refs/heads/checkpoint:refs/remotes/evidence/checkpoint
git diff <base-revision> refs/remotes/evidence/checkpoint
```

The bundle's checked-out `HEAD` is the checkpoint's result commit. Its parent
is typically the base revision used for the task; if the task was rebased, the
parent is the head it was rebased onto. Compare the result commit with the
completion record when you need to confirm the exact integrated revision.

## Integrity and safety

- The service verifies the bundle's SHA-256 and declared Git objects before
  treating checkpoint evidence as valid.
- The bundle is content-addressed and immutable once published.
- Checkpoint bundles may be up to 512 MiB in the current contract.
- The Console reads the artifact through the authenticated service API and
  scopes it to the open repository.
- Do not edit, recompress, or rewrite a bundle you intend to use as evidence;
  create a new copy instead.
- If `git bundle verify` fails, treat the evidence as unavailable and reconcile
  the runtime state rather than trying to repair the file in place.

## Related documentation

- [Local execution deep dive](local-execution-deep-dive.md) — checkpoint,
  completion and persistence model.
- [Forge Console](forge-console.md#evidence-and-git-bundles) — Evidence view and
  download workflow.
- [ADR-086](adr/086-replay-integrated-task-completions.md) — completion replay
  and durable task evidence.
- [ADR-087](adr/087-runtime-evidence-and-live-console.md) — runtime evidence and
  the Console Evidence API.
- Implementation: `tools/dapr-engine/execution/workspace-reconstruction.ts`,
  `tools/dapr-engine/orchestration/execution-host.ts`, and
  `tools/dapr-engine/service/evidence.ts`.
