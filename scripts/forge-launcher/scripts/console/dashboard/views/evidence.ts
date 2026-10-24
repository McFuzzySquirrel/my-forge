// ─── Evidence: durable work/validation/bundle artifacts from service runs ───

import { api } from "../api.js";
import { el, fmtTime } from "../render/dom.js";
import type {
  EvidenceArtifactRef,
  EvidenceArtifactResponse,
  EvidenceIndex,
  EvidenceRecord,
} from "../types.js";

let generation = 0;
let index: EvidenceIndex | null = null;
let listHost: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let selectedKey: string | null = null;

export function unmountEvidence(): void {
  generation += 1;
  index = null;
  listHost = null;
  detailHost = null;
  selectedKey = null;
}

export function renderEvidence(container: HTMLElement): void {
  unmountEvidence();
  container.textContent = "";
  container.appendChild(el("h2", null, "Evidence"));
  container.appendChild(el("p", { className: "dim" },
    "Durable work, validation and git-bundle evidence recorded by integrated service tasks. " +
    "These artifacts live in the runtime data volume, not in the repository."));

  const refresh = el("button", { className: "btn btn-sm", type: "button" }, "Refresh");
  refresh.addEventListener("click", () => void load());
  container.appendChild(el("div", { className: "row gap", style: "margin-bottom:8px" }, refresh));

  listHost = el("div", { className: "panel list-pane" }, el("p", { className: "dim" }, "Loading evidence…"));
  detailHost = el("div", { className: "panel" }, el("p", { className: "dim" }, "Select a completed task."));
  container.appendChild(el("div", { className: "grid-2" }, [listHost, detailHost]));
  void load();
}

async function load(): Promise<void> {
  const myGeneration = ++generation;
  try {
    const next = await api.serviceEvidence();
    if (myGeneration !== generation) return;
    index = next;
    renderList();
    if (selectedKey) {
      const found = findRecord(selectedKey);
      if (found) renderDetail(found);
      else {
        selectedKey = null;
        if (detailHost) detailHost.replaceChildren(el("p", { className: "dim" }, "Select a completed task."));
      }
    }
  } catch (error) {
    if (myGeneration !== generation || !listHost) return;
    listHost.replaceChildren(el("p", { className: "error-text", role: "alert" },
      `Unable to load evidence: ${(error as Error).message}`));
  }
}

function recordKey(record: EvidenceRecord): string {
  return `${record.taskId}\0${record.runId}\0${record.commitSha}`;
}

function findRecord(key: string): EvidenceRecord | null {
  for (const task of index?.tasks ?? []) {
    for (const record of task.records) if (recordKey(record) === key) return record;
  }
  return null;
}

function renderList(): void {
  if (!listHost) return;
  listHost.textContent = "";
  const tasks = index?.tasks ?? [];
  if (tasks.length === 0) {
    listHost.appendChild(el("p", { className: "dim" }, "No integrated task evidence for this repository yet."));
    return;
  }
  const list = el("ul", { className: "doc-list" });
  for (const task of tasks) {
    for (const record of task.records) {
      const key = recordKey(record);
      const item = el("li", { className: key === selectedKey ? "doc-item active" : "doc-item" }, [
        el("span", { className: "kind" }, task.taskId),
        el("span", { className: "mono small" }, record.commitSha.slice(0, 12)),
        el("span", { className: "dim small" }, fmtTime(record.completedAt)),
      ]);
      item.setAttribute("tabindex", "0");
      item.setAttribute("role", "button");
      const select = (): void => {
        selectedKey = key;
        renderList();
        renderDetail(record);
      };
      item.addEventListener("click", select);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      list.appendChild(item);
    }
  }
  listHost.appendChild(list);
}

function renderDetail(record: EvidenceRecord): void {
  if (!detailHost) return;
  detailHost.textContent = "";
  detailHost.appendChild(el("div", { className: "row between" }, [
    el("h3", null, record.taskId),
    el("span", { className: "badge" }, "complete"),
  ]));
  detailHost.appendChild(el("div", { className: "stats" }, [
    stat("Commit", record.commitSha.slice(0, 12)),
    stat("Base", record.baseRevision.slice(0, 12)),
    stat("Run", record.runId),
    stat("Completed", fmtTime(record.completedAt)),
    stat("Files", String(record.outputFiles.length)),
    stat("Validation", String(record.validationCommands.length)),
  ]));
  if (record.outputFiles.length) {
    detailHost.appendChild(el("div", { className: "field" }, [
      el("div", { className: "k" }, "Output files"),
      el("div", { className: "mono small" }, record.outputFiles.join("\n")),
    ]));
  }
  if (record.validationCommands.length) {
    detailHost.appendChild(el("div", { className: "field" }, [
      el("div", { className: "k" }, "Validation commands"),
      el("div", { className: "mono small" }, record.validationCommands.join("\n")),
    ]));
  }

  const artifacts: Array<[string, EvidenceArtifactRef | undefined]> = [
    ["Work artifact", record.workArtifact],
    ["Validation artifact", record.validationArtifact],
    ["Git bundle", record.bundleArtifact],
  ];
  detailHost.appendChild(el("div", { className: "actions" }, artifacts.flatMap(([label, ref]) => {
    if (!ref) return [el("span", { className: "dim small" }, `${label}: not produced`)];
    const button = el("button", { className: "btn btn-sm", type: "button" }, label);
    button.addEventListener("click", () => void openArtifact(ref, label === "Git bundle"));
    return [button];
  })));
  detailHost.appendChild(el("pre", { className: "log-view", "aria-live": "polite" }, "Select an artifact to inspect it."));
}

function stat(key: string, value: string): HTMLElement {
  return el("div", { className: "stat" }, [
    el("div", { className: "k" }, key),
    el("div", { className: "v mono" }, value),
  ]);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function openArtifact(ref: EvidenceArtifactRef, download: boolean): Promise<void> {
  if (!detailHost) return;
  const pre = detailHost.querySelector<HTMLElement>("pre");
  if (pre) pre.textContent = "Loading artifact…";
  try {
    const artifact: EvidenceArtifactResponse = await api.serviceEvidenceArtifact(ref.artifactId);
    const bytes = decodeBase64(artifact.content);
    if (download) {
      const blob = new Blob([bytes as BlobPart], { type: artifact.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${ref.artifactId}.bundle`;
      anchor.click();
      URL.revokeObjectURL(url);
      if (pre) pre.textContent = `Downloaded ${ref.sizeBytes} bytes (${ref.sha256}).`;
      return;
    }
    const text = new TextDecoder().decode(bytes);
    if (pre) {
      try {
        pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pre.textContent = text;
      }
    }
  } catch (error) {
    if (pre) pre.textContent = `Unable to load artifact: ${(error as Error).message}`;
  }
}
