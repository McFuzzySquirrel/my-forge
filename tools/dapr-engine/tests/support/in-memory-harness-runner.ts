import type {
  HarnessRunner,
  HarnessRunnerRequestV1,
  HarnessRunnerResultV1,
} from "../../execution/runner-contract.ts";

export type InMemoryHarnessRun = (
  request: HarnessRunnerRequestV1,
  signal?: AbortSignal,
) => Promise<HarnessRunnerResultV1>;

export class InMemoryHarnessRunner implements HarnessRunner {
  readonly requests: HarnessRunnerRequestV1[] = [];

  constructor(private readonly execute: InMemoryHarnessRun) {}

  async run(
    request: HarnessRunnerRequestV1,
    signal?: AbortSignal,
  ): Promise<HarnessRunnerResultV1> {
    if (signal?.aborted) throw signal.reason ?? new Error("Harness execution was cancelled.");
    const snapshot = structuredClone(request);
    this.requests.push(snapshot);
    const result = await this.execute(snapshot, signal);
    if (signal?.aborted) throw signal.reason ?? new Error("Harness execution was cancelled.");
    return structuredClone(result);
  }
}
