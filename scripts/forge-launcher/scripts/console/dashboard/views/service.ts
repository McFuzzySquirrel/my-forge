// ─── Service runs: monitor and control local execution-service runs ─────────
//
// Polls the Console's service proxy. Events are fetched after the last seen
// sequence number, so a reconnect or reload resumes from the service's record
// rather than from browser state.

import { api } from "../api.js";
import { el, fmtTime, statusBadge, toast } from "../render/dom.js";
import type { ServiceRunDetail, ServiceRunEvent, ServiceRunRecord, ServiceRunTask } from "../types.js";

const POLL_MS = 2000;
const MAX_EVENTS = 500;
const TERMINAL = new Set(["complete", "failed", "cancelled"]);

let generation = 0;
let latestPoll = 0;
let timer: number | undefined;
let listHost: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let selectedRunId: string | null = null;
let events: ServiceRunEvent[] = [];
let cursor = 0;
let pending = new Set<string>();

export function unmountService(): void {
  generation++;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  listHost = null;
  detailHost = null;
  selectedRunId = null;
  events = [];
  cursor = 0;
  pending = new Set();
}

export function renderService(container: HTMLElement): void {
  unmountService();
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  selectedRunId = query.get("run");
  listHost = el("div", { className: "service-runs" }, el("p", { className: "dim" }, "Loading service runs…"));
  detailHost = el("div", { className: "service-run-detail" });
  container.appendChild(el("h2", null, "Service runs"));
  container.appendChild(el("p", { className: "dim" },
    "Runs submitted to the local execution service with \"forge-launcher service submit\". " +
    "Controls are sent to the service and show its acknowledgement."));
  container.appendChild(el("div", { className: "panel" }, listHost));
  container.appendChild(detailHost);
  void poll(generation);
}

async function poll(owner: number): Promise<void> {
  const mine = ++latestPoll;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  // A newer poll (selection change, control acknowledgement) supersedes this one.
  const current = () => owner === generation && mine === latestPoll;
  try {
    const list = await api.serviceRuns();
    if (!current()) return;
    renderList(list.available, list.runs, list.message);
    if (selectedRunId) {
      let detail: ServiceRunDetail;
      do {
        detail = await api.serviceRun(selectedRunId, cursor);
        if (!current()) return;
        events.push(...detail.events);
        cursor = detail.cursor;
      } while (detail.hasMore);
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      renderDetail(detail.run);
    }
  } catch (error) {
    if (!current()) return;
    if (detailHost && selectedRunId) {
      detailHost.textContent = "";
      detailHost.appendChild(el("div", { className: "panel" },
        el("p", { className: "dim" }, `Could not load run ${selectedRunId}: ${(error as Error).message}`)));
    }
  }
  if (current()) timer = window.setTimeout(() => void poll(owner), POLL_MS);
}

function select(runId: string): void {
  if (runId === selectedRunId) return;
  selectedRunId = runId;
  events = [];
  cursor = 0;
  history.replaceState(null, "", `#/service?run=${encodeURIComponent(runId)}`);
  if (detailHost) {
    detailHost.textContent = "";
    detailHost.appendChild(el("div", { className: "panel" }, el("p", { className: "dim" }, "Loading run…")));
  }
  void poll(generation);
}

function renderList(available: boolean, runs: ServiceRunRecord[], message?: string): void {
  if (!listHost) return;
  listHost.textContent = "";
  if (!available) {
    listHost.appendChild(el("p", { className: "dim" }, message ?? "The local execution service is not available."));
    return;
  }
  if (!runs.length) {
    listHost.appendChild(el("p", { className: "dim" }, "No service runs for this repository yet."));
    return;
  }
  const rows = runs.map((run) => {
    const row = el("tr", { className: run.runId === selectedRunId ? "selected clickable" : "clickable" }, [
      el("td", { className: "mono small" }, run.runId),
      el("td", null, statusBadge(run.status)),
      el("td", { className: "mono small" }, run.targetRef.replace(/^refs\/heads\//, "")),
      el("td", { className: "small" }, fmtTime(run.createdAt)),
      el("td", null, run.hostExecution === true ? "Host runner" : "Worker"),
    ]);
    row.addEventListener("click", () => select(run.runId));
    return row;
  });
  listHost.appendChild(el("div", { className: "table-scroll" }, el("table", null, [
    el("thead", null, el("tr", null, [el("th", null, "Run"), el("th", null, "Status"), el("th", null, "Branch"), el("th", null, "Created"), el("th", null, "Executor")])),
    el("tbody", null, rows),
  ])));
}

function controlButton(run: ServiceRunRecord, label: string, action: string, taskId?: string, danger = false): HTMLElement {
  const key = `${action}:${taskId ?? ""}`;
  const button = el("button", {
    className: `btn btn-sm${danger ? " btn-danger" : ""}`,
    disabled: pending.has(key),
    "data-action": action,
  }, label) as HTMLButtonElement;
  button.addEventListener("click", () => {
    if (action === "cancel" && !window.confirm(`Cancel run ${run.runId}? Running tasks are stopped and the run cannot resume.`)) return;
    pending.add(key);
    button.disabled = true;
    api.serviceControl(run.runId, action, taskId)
      .then((result) => toast(`${label}: ${result.state}`))
      .catch((error: unknown) => toast(`${label} failed: ${(error as Error).message}`))
      .finally(() => {
        pending.delete(key);
        void poll(generation);
      });
  });
  return button;
}

function runControls(run: ServiceRunRecord): HTMLElement {
  const status = run.status;
  const buttons: HTMLElement[] = [];
  if (status === "queued" || status === "running") buttons.push(controlButton(run, "Pause", "pause"));
  if (status === "paused") buttons.push(controlButton(run, "Resume", "resume"));
  if (status === "queued" || status === "running" || status === "paused") buttons.push(controlButton(run, "Stop", "stop"));
  if (!TERMINAL.has(status) && status !== "cancelling") buttons.push(controlButton(run, "Cancel", "cancel", undefined, true));
  return el("div", { className: "actions" }, buttons.length ? buttons : el("span", { className: "dim" }, "No run controls apply."));
}

function taskAction(run: ServiceRunRecord, task: ServiceRunTask): HTMLElement | null {
  if (task.status === "waiting-for-approval") return controlButton(run, `Approve ${task.taskId}`, "approve-task", task.taskId);
  if (task.status === "failed") return controlButton(run, `Replay ${task.taskId}`, "replay-task", task.taskId);
  return null;
}

function describe(event: ServiceRunEvent): string {
  const parts: string[] = [];
  if (event.taskId) parts.push(`task ${event.taskId}`);
  if (event.logicalAttempt) parts.push(`attempt ${event.logicalAttempt}`);
  const status = event.runStatus ?? event.taskStatus ?? event.attemptStatus;
  if (status) parts.push(status);
  return parts.join(" · ");
}

function renderDetail(run: ServiceRunRecord): void {
  if (!detailHost) return;
  detailHost.textContent = "";
  const tasks = run.tasks ?? [];
  const taskRows = tasks.map((task) => el("tr", null, [
    el("td", { className: "mono small" }, task.taskId),
    el("td", null, statusBadge(task.status)),
    el("td", { className: "small" }, task.logicalAttempt ? String(task.logicalAttempt) : "—"),
    el("td", null, taskAction(run, task)),
  ]));
  const eventItems = [...events].reverse().map((event) => el("div", { className: "tl-item" }, [
    el("div", { className: "tl-time" }, `#${event.sequence} ${fmtTime(event.createdAt)}`),
    el("div", { className: "row gap" }, [el("span", { className: "badge" }, event.eventType), el("span", { className: "dim" }, describe(event))]),
  ]));
  detailHost.appendChild(el("div", { className: "panel" }, [
    el("div", { className: "row gap" }, [el("h3", null, run.runId), statusBadge(run.status)]),
    el("p", { className: "dim small" },
      `Branch ${run.targetRef.replace(/^refs\/heads\//, "")} · harness ${run.harness?.id ?? "unknown"}. ` +
      `Executor: ${run.hostExecution === true ? "local host runner" : "worker container"}. ` +
      `Merge finished runs with "forge-launcher service merge ${run.runId}".`),
    run.hostExecution === true
      ? el("p", { className: "dim small" }, [
        el("a", { href: `#/host-runner?repositoryId=${encodeURIComponent(run.repositoryId)}` }, "View this repository's host-runner jobs"),
      ])
      : null,
    runControls(run),
  ]));
  detailHost.appendChild(el("div", { className: "panel" }, [
    el("h3", null, "Tasks"),
    el("p", { className: "dim small" }, [
      el("a", { href: "#/evidence" }, "Open durable task evidence"),
      " for work, validation and git-bundle artifacts.",
    ]),
    tasks.length
      ? el("div", { className: "table-scroll" }, el("table", null, [
        el("thead", null, el("tr", null, [el("th", null, "Task"), el("th", null, "Status"), el("th", null, "Attempt"), el("th", null, "")])),
        el("tbody", null, taskRows),
      ]))
      : el("p", { className: "dim" }, "No tasks reported yet."),
  ]));
  detailHost.appendChild(el("div", { className: "panel" }, [
    el("h3", null, `Events (${cursor})`),
    el("div", { className: "timeline" }, eventItems.length ? eventItems : el("p", { className: "dim" }, "No events yet.")),
  ]));
}
