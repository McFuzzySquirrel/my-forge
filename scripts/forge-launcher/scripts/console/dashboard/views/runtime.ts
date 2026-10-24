// Runtime infrastructure administration. Workflow-run controls remain on the
// Service runs page; these actions affect the shared local runtime.

import { api } from "../api.js";
import { el, statusBadge } from "../render/dom.js";
import type { RuntimeAdminAction, RuntimeAdminState } from "../types.js";

const HARNESS_VARIABLES: Record<string, string[]> = {
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  opencode: [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY", "OPENCODE_AUTH_JSON",
  ],
};

let host: HTMLElement | null = null;
let state: RuntimeAdminState | null = null;
let selectedRepo = "";
let busy = false;
let message = "";
let errorMessage = "";
let generation = 0;

export function unmountRuntime(): void {
  generation++;
  host = null;
  state = null;
  selectedRepo = "";
  busy = false;
  message = "";
  errorMessage = "";
}

export function renderRuntime(container: HTMLElement): void {
  unmountRuntime();
  host = container;
  container.appendChild(el("h1", null, "Local runtime"));
  container.appendChild(el("p", { className: "dim" },
    "Manage the shared Podman runtime used for local execution. Service-run controls are on the Service runs page."));
  container.appendChild(el("p", { className: "dim" }, [
    "Host-runner status, project capabilities, and job history are managed on the ",
    el("a", { href: "#/host-runner" }, "Host runner page"),
    ".",
  ]));
  draw();
  void refresh(generation);
}

async function refresh(owner = generation): Promise<void> {
  const [runtimeResult, summaryResult] = await Promise.allSettled([api.runtime(), api.summary()]);
  if (owner !== generation) return;
  if (runtimeResult.status === "fulfilled") {
    state = runtimeResult.value;
    errorMessage = "";
  } else {
    errorMessage = runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason);
  }
  if (summaryResult.status === "fulfilled") selectedRepo = summaryResult.value?.repoRoot ?? "";
  else if (!errorMessage) errorMessage = summaryResult.reason instanceof Error ? summaryResult.reason.message : String(summaryResult.reason);
  draw();
}

function draw(): void {
  if (!host) return;
  host.querySelector(".runtime-page")?.remove();
  const page = el("div", { className: "runtime-page" });
  host.appendChild(page);

  const refreshButton = button("Refresh status", () => void refresh());
  refreshButton.disabled = busy;
  page.appendChild(el("div", { className: "row between runtime-heading" }, [
    el("h2", { className: "no-margin" }, "Runtime status"),
    refreshButton,
  ]));

  if (errorMessage) page.appendChild(el("div", { className: "panel error-text", role: "alert" }, errorMessage));
  if (message) page.appendChild(el("div", { className: "panel hint", role: "status" }, message));
  if (busy) page.appendChild(el("div", { className: "panel runtime-progress", role: "status", "aria-live": "polite" }, [
    el("span", { className: "spinner" }),
    el("span", null, "Runtime operation in progress. This may take several minutes."),
  ]));

  page.appendChild(renderStatus());
  page.appendChild(renderLifecycle());
  page.appendChild(renderRepositories());
  page.appendChild(renderBackup());
  page.appendChild(renderCredentials());
}

function renderStatus(): HTMLElement {
  if (!state) return el("div", { className: "panel" }, "Loading runtime status…");
  const content: HTMLElement[] = [
    el("div", { className: "row gap" }, [
      statusBadge(state.status),
      el("span", { className: "dim" }, `Compose project: ${state.project}`),
      state.restartRequired ? statusBadge("restart-required") : el("span", { className: "dim" }, "Runtime is current."),
    ]),
  ];
  if (!state.initialized) {
    content.push(el("p", { className: "dim" }, "The runtime has not been initialized. Start it to create the local runtime."));
  } else {
    if (!state.startOptions) {
      content.push(el("p", { className: "dim" },
        "No saved start options are available yet. Confirm the host-tools checkbox and PostgreSQL port before restarting an older runtime."));
    }
    if (state.missingServices.length) {
      content.push(el("p", { className: "dim" }, `Services not ready: ${state.missingServices.join(", ")}`));
    }
  }
  if (state.containers.length) {
    content.push(el("div", { className: "table-scroll" }, el("table", null, [
      el("thead", null, el("tr", null, ["Service", "State", "Health"].map((label) => el("th", null, label)))),
      el("tbody", null, state.containers.map((container) => el("tr", null, [
        el("td", null, container.service || container.name),
        el("td", null, container.state),
        el("td", null, container.health ?? "—"),
      ]))),
    ])));
  }
  for (const diagnostic of state.diagnostics) {
    content.push(el("pre", { className: "runtime-diagnostic" }, diagnostic));
  }
  if (state.restartRequired) {
    const buildStale = state.appliedLauncherVersion !== state.launcherVersion;
    content.push(el("p", { className: "dim" },
      buildStale
        ? state.appliedLauncherVersion === null
          ? `The runtime was started by an older launcher build; this command is v${state.launcherVersion}. Use the separate, confirmed Restart action below to load the installed build.`
          : `The runtime was started by launcher v${state.appliedLauncherVersion}; this command is v${state.launcherVersion}. Use the separate, confirmed Restart action below to load the installed build.`
        : "Repository registration changed since the runtime was last started. Use the separate, confirmed Restart action below to apply it."));
  }
  if (state.hostRunnerStatus === "running" && state.hostRunnerLauncherVersion !== state.launcherVersion) {
    content.push(el("p", { className: "dim" },
      state.hostRunnerLauncherVersion === null
        ? `The host runner was started by an older launcher build; this command is v${state.launcherVersion}. Starting the runtime now replaces it automatically.`
        : `The host runner was started by launcher v${state.hostRunnerLauncherVersion}; this command is v${state.launcherVersion}. Starting the runtime now replaces it automatically.`));
  }
  return el("section", { className: "panel" }, content);
}

function renderLifecycle(): HTMLElement {
  const options = el("div", { className: "form-row" });
  const hostTools = el("input", { type: "checkbox", disabled: busy }) as HTMLInputElement;
  hostTools.checked = state?.startOptions?.hostTools ?? false;
  const postgresPort = el("input", {
    type: "number",
    min: 1,
    max: 65535,
    value: state?.startOptions?.postgresPort ?? 55432,
    disabled: busy,
  }) as HTMLInputElement;
  options.append(
    field("Expose PostgreSQL to host tools", hostTools, true),
    field("PostgreSQL host port", postgresPort),
  );
  const start = button("Start", () => void runAction({
    action: "start",
    hostTools: hostTools.checked,
    ...(hostTools.checked ? { postgresPort: Number(postgresPort.value) } : {}),
  }));
  const alreadyActive = state?.status === "running" || state?.status === "degraded";
  if (alreadyActive) {
    start.disabled = true;
    start.title = "Use Restart to apply options to an active runtime.";
  }
  const stop = button("Stop", () => {
    if (window.confirm("Stop the shared runtime? This can interrupt active workflow runs; persistent data is preserved.")) {
      void runAction({ action: "stop", confirmed: true });
    }
  }, true);
  const restart = button("Restart", () => {
    if (window.confirm("Restart the shared runtime? Active workflow runs may be interrupted. Repository mount changes will be applied.")) {
      void runAction({
        action: "restart",
        confirmed: true,
        hostTools: hostTools.checked,
        ...(hostTools.checked ? { postgresPort: Number(postgresPort.value) } : {}),
      });
    }
  });
  const reset = button("Reset data", () => {
    if (window.confirm("Reset the runtime and permanently remove its persistent volumes? This cannot be undone.")) {
      void runAction({ action: "reset", confirmed: true });
    }
  }, true);
  const rotate = button("Rotate API tokens", () => {
    if (window.confirm("Rotate the runtime API and Dapr sidecar tokens? The runtime must be restarted before service commands will work.")) {
      void runAction({ action: "rotate-tokens", confirmed: true });
    }
  }, true);
  for (const control of [start, stop, restart, reset, rotate]) control.disabled ||= busy;
  return el("section", { className: "panel" }, [
    el("h3", null, "Lifecycle"),
    el("p", { className: "dim" }, "Stopping and restarting may interrupt active workflow runs. They do not delete persistent data."),
    options,
    el("div", { className: "actions" }, [start, stop, restart, reset, rotate]),
  ]);
}

function renderRepositories(): HTMLElement {
  const pathInput = el("input", { type: "text", placeholder: "/path/to/git/repository", value: selectedRepo, disabled: busy }) as HTMLInputElement;
  const idInput = el("input", { type: "text", placeholder: "Optional runtime ID", disabled: busy }) as HTMLInputElement;
  const add = button("Register repository", () => void runAction({
    action: "repo-add",
    path: pathInput.value,
    ...(idInput.value ? { id: idInput.value } : {}),
  }));
  add.disabled = busy;
  const selectedButton = button("Use selected project", () => { pathInput.value = selectedRepo; });
  selectedButton.disabled = busy || !selectedRepo;
  const rows = state?.repositories.map((repository) => {
    const remove = button("Unregister", () => {
      if (window.confirm(`Unregister '${repository.id}'? A separate runtime restart is required to unmount it.`)) {
        void runAction({ action: "repo-remove", id: repository.id, confirmed: true });
      }
    }, true);
    remove.disabled = busy;
    return el("tr", null, [
      el("td", { className: "mono" }, repository.id),
      el("td", { className: "mono" }, repository.path),
      el("td", null, remove),
    ]);
  }) ?? [];
  return el("section", { className: "panel" }, [
    el("h3", null, "Repository registry"),
    el("p", { className: "dim" }, "Only each repository's .git directory is mounted into the runtime. Registering a repository also enables its host-runner capability; host execution for a run remains a separate Overview opt-in. Repository registration changes require a separate runtime restart. Manage project-scoped host-runner capabilities on the Host runner page."),
    el("div", { className: "form-row" }, [
      field("Repository path", pathInput),
      field("Runtime ID", idInput),
    ]),
    el("div", { className: "actions" }, [add, selectedButton]),
    rows.length
      ? el("div", { className: "table-scroll" }, el("table", null, [
        el("thead", null, el("tr", null, ["ID", "Repository", "Actions"].map((label) => el("th", null, label)))),
        el("tbody", null, rows),
      ]))
      : el("p", { className: "dim" }, "No repositories are registered."),
  ]);
}

function renderBackup(): HTMLElement {
  const backupPath = el("input", { type: "text", placeholder: "/path/to/backup-directory", disabled: busy }) as HTMLInputElement;
  const backup = button("Create backup", () => {
    if (window.confirm("Create a runtime backup? A running service is temporarily stopped and active workflow runs may be interrupted.")) {
      void runAction({ action: "backup", output: backupPath.value });
    }
  });
  backup.disabled = busy;
  const restorePath = el("input", { type: "text", placeholder: "/path/to/backup-directory", disabled: busy }) as HTMLInputElement;
  const allowGitDrift = el("input", { type: "checkbox", disabled: busy }) as HTMLInputElement;
  const restore = button("Restore backup", () => {
    if (!window.confirm("Restore this backup? All runtime persistent volumes will be replaced.")) return;
    if (allowGitDrift.checked &&
      !window.confirm("Git drift can leave execution history inconsistent and cause work to be integrated again. Accept this risk and continue?")) return;
    void runAction({
      action: "restore",
      from: restorePath.value,
      confirmed: true,
      allowGitDrift: allowGitDrift.checked,
    });
  }, true);
  restore.disabled = busy;
  return el("section", { className: "panel" }, [
    el("h3", null, "Backup and restore"),
    el("div", { className: "form-row" }, [field("Backup destination", backupPath), el("div", { className: "runtime-field-actions" }, backup)]),
    el("div", { className: "form-row" }, [field("Restore source", restorePath), el("div", { className: "runtime-field-actions" }, restore)]),
    field("Allow Git drift (explicit acknowledgement required)", allowGitDrift, true),
  ]);
}

function renderCredentials(): HTMLElement {
  const harness = el("select", { disabled: busy }) as HTMLSelectElement;
  for (const name of Object.keys(HARNESS_VARIABLES)) harness.appendChild(el("option", { value: name }, name));
  const variable = el("select", { disabled: busy }) as HTMLSelectElement;
  const populateVariables = () => {
    variable.replaceChildren(...(HARNESS_VARIABLES[harness.value] ?? []).map((name) => el("option", { value: name }, name)));
  };
  harness.addEventListener("change", populateVariables);
  populateVariables();
  const secret = el("input", { type: "password", autocomplete: "new-password", disabled: busy }) as HTMLInputElement;
  const grant = button("Grant credential", () => {
    const value = secret.value;
    secret.value = "";
    void runAction({ action: "harness-grant", harness: harness.value, variable: variable.value, value });
  });
  grant.disabled = busy;
  const grantForm = el("div", { className: "form-row" }, [
    field("Harness", harness),
    field("Credential variable", variable),
    field("Credential value (never displayed again)", secret),
  ]);
  const rows = Object.entries(state?.harnessGrants ?? {}).flatMap(([name, variables]) => variables.map((variableName) => {
    const revoke = button("Revoke", () => {
      if (window.confirm(`Revoke ${variableName} for ${name}?`)) {
        void runAction({ action: "harness-revoke", harness: name, variable: variableName, confirmed: true });
      }
    }, true);
    revoke.disabled = busy;
    return el("tr", null, [el("td", null, name), el("td", { className: "mono" }, variableName), el("td", null, revoke)]);
  }));
  const revokeAll: HTMLElement[] = Object.entries(state?.harnessGrants ?? {})
    .filter(([, variables]) => variables.length > 0)
    .map(([name]) => {
      const revoke = button(`Revoke all ${name} grants`, () => {
        if (window.confirm(`Revoke every credential granted to ${name}?`)) {
          void runAction({ action: "harness-revoke", harness: name, confirmed: true });
        }
      }, true);
      revoke.disabled = busy;
      return revoke;
    });
  return el("section", { className: "panel" }, [
    el("h3", null, "Harness credentials"),
    el("p", { className: "dim" }, "Credential values are stored locally with restricted permissions. The Console lists variable names only and never returns or redisplays secret values."),
    grantForm,
    el("div", { className: "actions" }, [grant]),
    rows.length
      ? el("div", { className: "table-scroll" }, el("table", null, [
        el("thead", null, el("tr", null, ["Harness", "Variable", "Action"].map((label) => el("th", null, label)))),
        el("tbody", null, rows),
      ]))
      : el("p", { className: "dim" }, "No harness credentials are granted."),
    el("div", { className: "actions" }, revokeAll),
  ]);
}

async function runAction(action: RuntimeAdminAction): Promise<void> {
  if (busy) return;
  const owner = generation;
  busy = true;
  message = "";
  errorMessage = "";
  draw();
  try {
    const result = await api.runtimeAction(action);
    if (owner !== generation) return;
    message = result.message + (result.restartRequired
      ? " Start or restart the runtime separately to apply this change."
      : "");
    state = await api.runtime();
  } catch (error) {
    if (owner !== generation) return;
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (owner === generation) {
      busy = false;
      draw();
    }
  }
}

function field(label: string, control: HTMLElement, checkbox = false): HTMLElement {
  return el("label", { className: checkbox ? "checkbox-row runtime-checkbox" : "field" }, [
    ...(checkbox ? [control, el("span", null, label)] : [el("span", null, label), control]),
  ]);
}

function button(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const control = el("button", { type: "button", className: `btn btn-sm${danger ? " btn-danger" : ""}` }, label) as HTMLButtonElement;
  control.addEventListener("click", onClick);
  return control;
}
