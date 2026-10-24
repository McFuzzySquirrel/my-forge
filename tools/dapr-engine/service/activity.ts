import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskFileId } from "../execution/task-execution.ts";

const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/;
const MAX_ACTIVITY_BYTES = 256 * 1024;
const MAX_ACTIVITY_LINES = 500;

export interface ActivityLogPage {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** Reads the opt-in per-attempt worker activity files from runtime storage. */
export class FileActivityLogStore {
  constructor(private readonly root: string) {}

  async read(runId: string, taskId: string, attempt: number): Promise<ActivityLogPage | undefined> {
    if (!RUN_ID_PATTERN.test(runId)) throw new TypeError("Invalid run id");
    if (!taskId || taskId.includes("\0")) throw new TypeError("Invalid task id");
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("Invalid attempt number");
    const file = join(this.root, runId, taskFileId(taskId), `attempt-${attempt}.log`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let truncated = false;
    if (Buffer.byteLength(text, "utf8") > MAX_ACTIVITY_BYTES) {
      text = Buffer.from(text, "utf8").subarray(-MAX_ACTIVITY_BYTES).toString("utf8");
      truncated = true;
    }
    const lines = text.replace(/\n$/, "").split("\n");
    if (lines.length > MAX_ACTIVITY_LINES) {
      truncated = true;
      return { lines: lines.slice(-MAX_ACTIVITY_LINES), truncated };
    }
    return { lines, truncated };
  }
}
