import { execFileSync } from "node:child_process";
import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  allocateTaskProcessIdentity,
  releaseTaskProcessIdentity,
  taskProcessPrivilegeArgs,
} from "../execution/isolation.ts";

const TASK_READ_PROBE = `
const fs = require("node:fs");
const status = fs.readFileSync("/proc/self/status", "utf8");
const capabilities = [...status.matchAll(/^Cap(?:Inh|Prm|Eff|Bnd|Amb):\\s+([0-9a-f]+)$/gm)];
if (process.getuid() !== Number(process.env.TASK_PROBE_UID)
  || process.getgid() !== Number(process.env.TASK_PROBE_GID)
  || process.getgroups().some((group) => group !== process.getgid())) {
  process.stdout.write("identity");
} else if (capabilities.length !== 5 || capabilities.some(([, value]) => /[1-9a-f]/i.test(value))) {
  process.stdout.write("capabilities");
} else if (!/^NoNewPrivs:\\s+1$/m.test(status)) {
  process.stdout.write("privileges");
} else {
try {
  fs.readFileSync(process.argv[1]);
  process.stdout.write("readable");
} catch (error) {
  process.stdout.write(error && (error.code === "EACCES" || error.code === "EPERM") ? "denied" : "error");
}
}
`;

/** Restricts every mounted source Git directory to the service owner and proves task UIDs are denied. */
export async function secureRegisteredGitMetadata(repositoriesRoot: string): Promise<void> {
  let repositories;
  try {
    repositories = await readdir(repositoriesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const repository of repositories) {
    if (!repository.isDirectory()) {
      throw new Error(`Unexpected entry in the registered repositories mount: '${repository.name}'`);
    }
    const gitRoot = join(repositoriesRoot, repository.name, ".git");
    let gitRootInfo;
    try {
      gitRootInfo = await lstat(gitRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Registered repository '${repository.name}' has no mounted .git directory`);
      }
      throw error;
    }
    if (!gitRootInfo?.isDirectory()) {
      throw new Error(`Registered repository '${repository.name}' has no mounted .git directory`);
    }

    await chmod(gitRoot, 0o700);
    const protectedInfo = await lstat(gitRoot);
    if ((protectedInfo.mode & 0o777) !== 0o700) {
      throw new Error(`Could not set owner-only permissions on registered repository '${repository.name}' Git metadata`);
    }
    await readdir(gitRoot);

    const identity = allocateTaskProcessIdentity();
    try {
      const output = execFileSync("setpriv", [
        ...taskProcessPrivilegeArgs(identity),
        process.execPath,
        "-e",
        TASK_READ_PROBE,
        join(gitRoot, "HEAD"),
      ], {
        encoding: "utf8",
        env: {
          HOME: "/tmp",
          TASK_PROBE_GID: String(identity.gid),
          TASK_PROBE_UID: String(identity.uid),
        },
        timeout: 5_000,
      }).trim();
      if (output !== "denied") {
        throw new Error(`task-identity probe did not prove denial (returned '${output}')`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not verify task UID isolation for registered repository '${repository.name}': ${detail}`);
    } finally {
      releaseTaskProcessIdentity(identity);
    }
  }
}
