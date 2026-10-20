/**
 * Maps runtime failure output (Podman, Compose, and redacted container logs)
 * to actionable remediation hints. Pure so it can be tested without Podman.
 */

const TROUBLESHOOTING = "docs/forge-launcher.md#runtime-troubleshooting";

interface HintRule {
  readonly pattern: RegExp;
  readonly hint: (platform: NodeJS.Platform) => string;
}

const usesPodmanMachine = (platform: NodeJS.Platform) => platform === "darwin" || platform === "win32";

const RULES: readonly HintRule[] = [
  {
    pattern: /schema version \d+ is newer than this Forge service supports|database files are incompatible with server/i,
    hint: () =>
      "Version mismatch: the runtime data was written by a newer Forge or PostgreSQL version. " +
      "Update forge-launcher, or restore a backup taken with this version (\"forge-launcher runtime restore\"). " +
      "Downgrades are not supported.",
  },
  {
    pattern: /no longer matches its recorded checksum|migration history has a gap/i,
    hint: () =>
      "The Forge schema history does not match this release. Restore a backup (\"forge-launcher runtime restore\") " +
      "or, to discard all runtime data, run \"forge-launcher runtime reset --confirm\".",
  },
  {
    pattern: /invalid page in block|could not read block|checksum failure|invalid (?:primary )?checkpoint record|could not locate a valid checkpoint|PANIC:|input\/output error/i,
    hint: () =>
      "A persistent volume appears to be corrupt. Restore a backup (\"forge-launcher runtime restore --from <dir> --confirm\") " +
      "or, to discard all runtime data, run \"forge-launcher runtime reset --confirm\".",
  },
  {
    pattern: /password authentication failed|role "[^"]+" does not exist/i,
    hint: () =>
      "Credential mismatch: runtime.env does not match the passwords stored in the runtime volumes " +
      "(for example, after the credential file was replaced). Restore the original runtime.env, or run " +
      "\"forge-launcher runtime reset --confirm\" to recreate the volumes with the current credentials.",
  },
  {
    pattern: /no space left on device|disk quota exceeded/i,
    hint: (platform) =>
      `Out of disk space. Free space${usesPodmanMachine(platform)
        ? ' or enlarge the Podman machine disk ("podman machine stop", "podman machine set --disk-size <GiB>", "podman machine start")'
        : ""}, then retry; "podman system df" shows image and volume usage.`,
  },
  {
    pattern: /OOMKilled|out of memory|cannot allocate memory/i,
    hint: (platform) =>
      `A container ran out of memory. Close other workloads${usesPodmanMachine(platform)
        ? ' or give the Podman machine more memory ("podman machine set --memory <MiB>"; 4096 or more is recommended)'
        : ""}, then retry.`,
  },
  {
    pattern: /address already in use|port is already allocated|bind: .*(?:in use|permission denied)/i,
    hint: () =>
      "A required loopback port is already in use. Stop the conflicting process, or export MYFORGE_API_PORT=<port> " +
      "for both runtime and service commands, or choose another --postgres-port.",
  },
  {
    pattern: /(?:pull access denied|manifest unknown|initializing source|error pulling image|unable to pull|requested access to the resource is denied|no such host|i\/o timeout|TLS handshake timeout|network is unreachable)/i,
    hint: () =>
      "Container images could not be pulled. Connect to the network and run \"forge-launcher runtime start\" once; " +
      `afterwards the runtime starts offline from the local image cache (see ${TROUBLESHOOTING}).`,
  },
  {
    pattern: /cannot connect to podman|podman\.sock|connection refused.*podman|vm .* (?:does not exist|not running)|podman machine/i,
    hint: (platform) => usesPodmanMachine(platform)
      ? 'The Podman machine is not running. Run "podman machine start" (or "podman machine init" first if none exists).'
      : 'The Podman service is not reachable. Check "podman info" and that your user session can run rootless containers.',
  },
];

/** Returns de-duplicated remediation hints for known failure signatures in `output`. */
export function remediationHints(output: string, platform: NodeJS.Platform = process.platform): string[] {
  const hints: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(output)) hints.push(rule.hint(platform));
  }
  return hints;
}

/** Appends hints, if any, to an error message. */
export function withRemediation(message: string, output: string, platform: NodeJS.Platform = process.platform): string {
  const hints = remediationHints(output, platform);
  return hints.length ? `${message}\n${hints.map((hint) => `Hint: ${hint}`).join("\n")}` : message;
}

/** Guidance for a missing or unusable Podman installation. */
export function podmanUnavailableMessage(
  reason: "missing" | "unreachable" | "not-rootless" | "no-compose",
  platform: NodeJS.Platform = process.platform,
  details = "",
): string {
  const machine = usesPodmanMachine(platform);
  const suffix = details ? `\n${details}` : "";
  switch (reason) {
    case "missing":
      return "Podman is required to manage the local runtime but was not found on PATH. " +
        "Install Podman (https://podman.io/docs/installation)" +
        (machine ? ', then run "podman machine init" and "podman machine start".' : ".");
    case "unreachable":
      return withRemediation(
        "Unable to inspect Podman. " + (machine
          ? 'Start the Podman machine with "podman machine start" (run "podman machine init" first if none exists).'
          : 'Confirm "podman info" succeeds for your user and that the rootless Podman service is available.'),
        details,
        platform,
      ) + suffix;
    case "not-rootless":
      return "Rootless Podman is required for the local runtime. " + (machine
        ? 'Switch the machine to rootless mode ("podman machine set --rootful=false") and restart it.'
        : "Run forge-launcher as your normal user, not root, and use a rootless Podman configuration.");
    case "no-compose":
      return 'The local runtime needs "podman compose" with a compose provider. ' +
        "Install podman-compose (for example \"pip install --user podman-compose\" or your OS package) and retry." + suffix;
  }
}
