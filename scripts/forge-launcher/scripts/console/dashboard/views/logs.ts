// ─── Logs: engine/runtime logs + audit, live-appended from SSE ───────────────

import { api } from "../api.js";
import { store, type LogSource } from "../state.js";
import { el, fmtTime } from "../render/dom.js";
import type { AuditEvent } from "../types.js";

const MAX_LINES = 500;

let unsub: Array<() => void> = [];
let logsGeneration = 0;

export function unmountLogs(): void {
  for (const u of unsub) u();
  unsub = [];
  logsGeneration += 1;
}

export function renderLogs(container: HTMLElement): void {
  unmountLogs();
  container.textContent = "";

  const queryStart = location.hash.indexOf("?");
  const hashQuery = new URLSearchParams(queryStart >= 0 ? location.hash.slice(queryStart + 1) : "");

  const engineTab = el("button", { className: "tab active", type: "button", "aria-selected": "true" }, "Activity log");
  const runtimeTab = el("button", { className: "tab", type: "button", "aria-selected": "false" }, "Runtime log");
  const auditTab = el("button", { className: "tab", type: "button", "aria-selected": "false" }, "Run events");
  const enginePanel = el("div", { className: "tab-panel" });
  const runtimePanel = el("div", { className: "tab-panel", style: "display:none" });
  const auditPanel = el("div", { className: "tab-panel", style: "display:none" });

  const show = (view: "engine" | "runtime" | "audit"): void => {
    const active = (tab: HTMLElement, on: boolean) => {
      tab.className = on ? "tab active" : "tab";
      tab.setAttribute("aria-selected", String(on));
    };
    active(engineTab, view === "engine");
    active(runtimeTab, view === "runtime");
    active(auditTab, view === "audit");
    enginePanel.style.display = view === "engine" ? "" : "none";
    runtimePanel.style.display = view === "runtime" ? "" : "none";
    auditPanel.style.display = view === "audit" ? "" : "none";
  };
  engineTab.addEventListener("click", () => show("engine"));
  runtimeTab.addEventListener("click", () => show("runtime"));
  auditTab.addEventListener("click", () => show("audit"));

  container.appendChild(
    el("div", { className: "panel" }, [
      el("div", { className: "tabs" }, [engineTab, runtimeTab, auditTab]),
      enginePanel,
      runtimePanel,
      auditPanel,
    ]),
  );

  renderLogSource(
    enginePanel,
    "engine",
    "No activity log yet. Authoring, team, skills and manifest output appears here; host-runner activity appears in the Runtime log tab.",
  );
  renderLogSource(
    runtimePanel,
    "runtime",
    "No runtime log yet. Start a service run or a host-runner job to populate this view.",
    hashQuery.get("filter") ?? "",
  );
  renderAudit(auditPanel);
  if (hashQuery.get("filter")) show("runtime");
}

function renderLogSource(panel: HTMLElement, source: LogSource, emptyText: string, initialFilter = ""): void {
  const pre = el("pre", { className: "log-view" });
  const empty = el("p", { className: "dim log-empty" }, emptyText);
  let follow = true;
  let unread = 0;
  let filter = initialFilter.trim().toLowerCase();
  const lines: string[] = [];
  const followToggle = el("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const unreadLabel = el("span", { className: "dim small", role: "status", "aria-live": "polite" });
  followToggle.addEventListener("change", () => {
    follow = followToggle.checked;
    if (follow) {
      unread = 0;
      unreadLabel.textContent = "";
      pre.scrollTop = pre.scrollHeight;
    }
  });
  panel.appendChild(el("div", { className: "row gap wrap log-controls" }, [
    el("label", { className: "checkbox-row" }, [followToggle, " Follow new lines"]),
    unreadLabel,
  ]));
  if (source === "runtime") {
    const filterInput = el("input", {
      type: "search",
      value: initialFilter,
      placeholder: "Filter lines (for example task=EVD-01)",
      "aria-label": "Filter runtime log lines",
    }) as HTMLInputElement;
    filterInput.addEventListener("input", () => {
      filter = filterInput.value.trim().toLowerCase();
      unread = 0;
      unreadLabel.textContent = "";
      redraw();
    });
    panel.appendChild(el("div", { className: "row gap wrap log-controls" }, [filterInput]));
    panel.appendChild(el("p", { className: "dim small log-source-note" },
      "Native host-runner log on this machine (all registered repositories)."));
  }
  panel.appendChild(empty);
  panel.appendChild(pre);

  const matches = (line: string): boolean => !filter || line.toLowerCase().includes(filter);

  const redraw = (): void => {
    const visible = lines.filter(matches).slice(-MAX_LINES);
    pre.textContent = "";
    for (const line of visible) pre.appendChild(el("div", { className: "log-line" }, line));
    empty.textContent = lines.length > 0 && filter ? "No lines match this filter." : emptyText;
    empty.style.display = visible.length > 0 ? "none" : "";
    if (follow) pre.scrollTop = pre.scrollHeight;
  };

  const appendLine = (line: string): void => {
    lines.push(line);
    if (lines.length > MAX_LINES * 4) lines.splice(0, lines.length - MAX_LINES * 4);
    if (!matches(line)) return;
    empty.style.display = "none";
    pre.appendChild(el("div", { className: "log-line" }, line));
    while (pre.childElementCount > MAX_LINES) {
      pre.removeChild(pre.firstElementChild!);
    }
    if (follow) pre.scrollTop = pre.scrollHeight;
    else {
      unread += 1;
      unreadLabel.textContent = `${unread} unread line${unread === 1 ? "" : "s"}`;
    }
  };

  const myGeneration = logsGeneration;
  void api.logs(400, source).then((res) => {
    if (myGeneration !== logsGeneration) return;
    for (const line of res.lines) appendLine(line);
    redraw();
  }).catch(() => {
    if (myGeneration === logsGeneration) unreadLabel.textContent = "Unable to load log; reconnecting…";
  });

  unsub.push(store.onLog((line, eventSource) => {
    if (myGeneration === logsGeneration && eventSource === source) appendLine(line);
  }));
}

function renderAudit(panel: HTMLElement): void {
  const table = el("table", null, [
    el("thead", null, [el("tr", null, [el("th", null, "Time"), el("th", null, "Action"), el("th", null, "Task"), el("th", null, "Note")])]),
  ]);
  const tbody = el("tbody", null);
  table.appendChild(tbody);
  panel.appendChild(table);

  const appendRow = (e: AuditEvent): void => {
    tbody.appendChild(
      el("tr", null, [
        el("td", { className: "small" }, fmtTime(e.timestamp)),
        el("td", null, el("span", { className: "badge" }, e.action)),
        el("td", { className: "mono small" }, e.taskId ?? "—"),
        el("td", null, e.note ?? ""),
      ]),
    );
    while (tbody.childElementCount > MAX_LINES) {
      tbody.removeChild(tbody.firstElementChild!);
    }
  };

  const myGeneration = logsGeneration;
  void api.audit().then((events) => {
    if (myGeneration !== logsGeneration) return;
    for (const e of events) appendRow(e);
  }).catch(() => {
    if (myGeneration === logsGeneration) panel.appendChild(el("div", { className: "error-text", role: "alert" }, "Unable to load audit events."));
  });

  unsub.push(store.onAudit(appendRow));
}
