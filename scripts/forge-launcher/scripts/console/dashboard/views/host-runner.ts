import { api } from "../api.js";
import { el, fmtTime, statusBadge } from "../render/dom.js";
import type { HostRunnerJobsResponse, RuntimeAdminAction, RuntimeAdminState } from "../types.js";

const REFRESH_MS = 5_000;

let generation = 0;
let timer: number | undefined;
let host: HTMLElement | null = null;
let runtime: RuntimeAdminState | null = null;
let jobs: HostRunnerJobsResponse | null = null;
let repositoryFilter = "";
let runtimeError = "";
let jobsError = "";
let message = "";
let busy = false;
let refreshing = false;

export function unmountHostRunner(): void {
  generation++;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  host = null;
  runtime = null;
  jobs = null;
  repositoryFilter = "";
  runtimeError = "";
  jobsError = "";
  message = "";
  busy = false;
  refreshing = false;
}

export function renderHostRunner(container: HTMLElement): void {
  unmountHostRunner();
  host = container;
  repositoryFilter = new URLSearchParams(location.hash.split("?")[1] ?? "").get("repositoryId") ?? "";
  container.appendChild(el("h1", null, "Host runner"));
  container.appendChild(el("p", { className: "dim" },
    "Inspect native runner readiness, manage project capabilities, and monitor bounded job summaries. Host execution runs local harnesses with your OS account's full permissions; it is not sandboxed."));
  draw();
  void refresh(generation);
}

async function refresh(owner = generation): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  const [runtimeResult, jobsResult] = await Promise.allSettled([
    api.runtime(),
    api.hostRunnerJobs(repositoryFilter || undefined),
  ]);
  if (owner !== generation) return;
  if (runtimeResult.status === "fulfilled") {
    runtime = runtimeResult.value;
    runtimeError = "";
  } else {
    runtimeError = runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason);
  }
  if (jobsResult.status === "fulfilled") {
    jobs = jobsResult.value;
    jobsError = "";
  } else {
    jobsError = jobsResult.reason instanceof Error ? jobsResult.reason.message : String(jobsResult.reason);
  }
  refreshing = false;
  draw();
  timer = window.setTimeout(() => void refresh(owner), REFRESH_MS);
}

function draw(): void {
  if (!host) return;
  host.querySelector(".host-runner-page")?.remove();
  const page = el("div", { className: "host-runner-page" });
  host.appendChild(page);

  const refreshButton = button("Refresh", () => void refresh());
  refreshButton.disabled = busy || refreshing;
  page.appendChild(el("div", { className: "row between runtime-heading" }, [
    el("h2", { className: "no-margin" }, "Runner status and capabilities"),
    refreshButton,
  ]));
  if (runtimeError) page.appendChild(el("div", { className: "panel error-text", role: "alert" }, runtimeError));
  if (jobsError) page.appendChild(el("div", { className: "panel error-text", role: "alert" }, `Job summaries unavailable: ${jobsError}`));
  if (message) page.appendChild(el("div", { className: "panel hint", role: "status" }, message));
  if (busy) page.appendChild(el("div", { className: "panel runtime-progress", role: "status", "aria-live": "polite" }, [
    el("span", { className: "spinner" }),
    el("span", null, "Updating host-runner capability…"),
  ]));

  page.appendChild(renderStatus());
  page.appendChild(renderCapabilities());
  page.appendChild(renderJobs());
}

function renderStatus(): HTMLElement {
  if (!runtime) return el("section", { className: "panel" }, "Loading host-runner status…");
  const content: HTMLElement[] = [
    el("div", { className: "row gap" }, [
      statusBadge(runtime.hostRunnerStatus),
      el("span", { className: "dim" }, `Runtime: ${runtime.status}`),
      runtime.restartRequired ? statusBadge("restart-required") : el("span", { className: "dim" }, "No pending restart."),
    ]),
    el("p", { className: "dim" }, [
      "Runtime lifecycle and repository registration are managed on the ",
      el("a", { href: "#/runtime" }, "Runtime page"),
      ". Capability changes are saved immediately but require a separate confirmed runtime restart.",
    ]),
  ];
  if (runtime.hostRunnerStatus !== "running") {
    content.push(el("p", { className: "dim" },
      "The native host runner is not running. Start or restart the local runtime, then refresh this page."));
  }
  content.push(el("p", { className: "dim small", role: "note" },
    "A project capability authorizes Dapr requests only. It does not restrict the harness or its child tools: host execution can access files, processes, and network resources available to your OS account."));
  return el("section", { className: "panel" }, content);
}

function renderCapabilities(): HTMLElement {
  const repositories = runtime?.repositories ?? [];
  if (!repositories.length) {
    return el("section", { className: "panel" }, [
      el("h3", null, "Project capabilities"),
      el("p", { className: "dim" }, [
        "No repositories are registered. Register a repository on the ",
        el("a", { href: "#/runtime" }, "Runtime page"),
        " before enabling host execution.",
      ]),
    ]);
  }
  const rows = repositories.map((repository) => {
    const enabled = runtime?.hostRunnerEnabledRepositoryIds.includes(repository.id) ?? false;
    const actions: HTMLButtonElement[] = [];
    if (enabled) {
      actions.push(button("Rotate capability", () => {
        if (window.confirm(`Rotate the host-runner capability for '${repository.id}'? A runtime restart is required before the change takes effect.`)) {
          void runAction({ action: "runner-capability", id: repository.id, operation: "rotate", confirmed: true });
        }
      }));
      actions.push(button("Revoke", () => {
        if (window.confirm(`Revoke the host-runner capability for '${repository.id}'? Host execution for this project will remain unavailable until it is enabled again and the runtime is restarted.`)) {
          void runAction({ action: "runner-capability", id: repository.id, operation: "revoke", confirmed: true });
        }
      }, true));
    } else {
      actions.push(button("Enable host runner", () => {
        if (window.confirm(
          `Enable host execution for '${repository.id}'? A selected local harness will run as your OS user with full account permissions, outside a task sandbox. Each run still requires a separate explicit host-execution opt-in.`,
        )) {
          void runAction({ action: "runner-capability", id: repository.id, operation: "enable", confirmed: true });
        }
      }));
    }
    for (const control of actions) control.disabled = busy || refreshing;
    return el("tr", null, [
      el("td", { className: "mono" }, repository.id),
      el("td", { className: "mono small" }, repository.path),
      el("td", null, enabled ? "Enabled" : "Disabled"),
      el("td", null, actions),
    ]);
  });
  return el("section", { className: "panel" }, [
    el("h3", null, "Project capabilities"),
    el("p", { className: "dim" }, "Capabilities are project-scoped, stored in owner-only local runtime data, and never shown here. Enablement is separate from the per-run host-execution choice in Overview."),
    el("div", { className: "table-scroll" }, el("table", null, [
      el("thead", null, el("tr", null, ["Repository ID", "Path", "Capability", "Actions"].map((label) => el("th", null, label)))),
      el("tbody", null, rows),
    ])),
  ]);
}

function renderJobs(): HTMLElement {
  const filter = el("select", { disabled: refreshing || busy }) as HTMLSelectElement;
  filter.appendChild(el("option", { value: "" }, "All registered repositories"));
  for (const repository of runtime?.repositories ?? []) {
    filter.appendChild(el("option", { value: repository.id }, repository.id));
  }
  if (repositoryFilter && !(runtime?.repositories.some((repository) => repository.id === repositoryFilter) ?? false)) {
    filter.appendChild(el("option", { value: repositoryFilter }, `${repositoryFilter} (not currently registered)`));
  }
  filter.value = repositoryFilter;
  filter.addEventListener("change", () => {
    repositoryFilter = filter.value;
    const query = repositoryFilter ? `?repositoryId=${encodeURIComponent(repositoryFilter)}` : "";
    history.replaceState(null, "", `#/host-runner${query}`);
    void refresh();
  });

  const section: HTMLElement[] = [
    el("div", { className: "row between" }, [
      el("h3", null, "Runner jobs"),
      el("label", { className: "field" }, [el("span", null, "Repository filter"), filter]),
    ]),
    el("p", { className: "dim" }, "Shows active jobs and up to the 20 most recently updated terminal jobs. CLI output, request payloads, results, error details, and capabilities are not exposed."),
  ];
  if (jobs?.activeTruncated) {
    section.push(el("p", { className: "panel hint" }, "More than 100 active jobs exist for this filter; only the newest 100 are shown."));
  }
  const entries = jobs?.jobs ?? [];
  if (entries.length) {
    const rows = entries.map((job) => el("tr", null, [
      el("td", null, statusBadge(job.state)),
      el("td", { className: "mono small" }, job.repositoryId),
      el("td", { className: "mono small" }, job.runId),
      el("td", { className: "mono small" }, job.taskId),
      el("td", null, job.harness),
      el("td", { className: "small" }, fmtTime(job.updatedAt)),
    ]));
    section.push(el("div", { className: "table-scroll" }, el("table", null, [
      el("thead", null, el("tr", null, ["State", "Repository", "Run", "Task", "Harness", "Updated"].map((label) => el("th", null, label)))),
      el("tbody", null, rows),
    ])));
  } else {
    section.push(el("p", { className: "dim" }, jobs ? "No host-runner jobs match this filter." : "Loading host-runner job summaries…"));
  }
  return el("section", { className: "panel" }, section);
}

async function runAction(action: RuntimeAdminAction): Promise<void> {
  if (busy) return;
  const owner = generation;
  busy = true;
  message = "";
  draw();
  try {
    const result = await api.runtimeAction(action);
    if (owner !== generation) return;
    message = result.message + (result.restartRequired
      ? " Restart the runtime separately to apply this change."
      : "");
    runtime = await api.runtime();
  } catch (error) {
    if (owner !== generation) return;
    message = error instanceof Error ? error.message : String(error);
  } finally {
    if (owner === generation) {
      busy = false;
      draw();
      void refresh(owner);
    }
  }
}

function button(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const control = el("button", {
    type: "button",
    className: `btn btn-sm${danger ? " btn-danger" : ""}`,
  }, label) as HTMLButtonElement;
  control.addEventListener("click", onClick);
  return control;
}
