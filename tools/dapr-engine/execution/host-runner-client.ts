import { parseHarnessRunnerRequest } from "./runner-contract.ts";
import type { HarnessRunnerRequestV1, HarnessRunnerResultV1 } from "./runner-contract.ts";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface HostRunnerClaimV1 {
  readonly leaseId: string;
  readonly request: HarnessRunnerRequestV1;
}

export interface HostRunnerJobStatusV1 {
  readonly state: "leased";
  readonly cancelRequested: boolean;
}

export interface HostRunnerClient {
  claim(repositoryId: string, capability: string): Promise<HostRunnerClaimV1 | undefined>;
  heartbeat(repositoryId: string, capability: string, operationId: string, leaseId: string): Promise<boolean>;
  get(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
  ): Promise<HostRunnerJobStatusV1 | undefined>;
  complete(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
    result: HarnessRunnerResultV1,
  ): Promise<void>;
  fail(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
    message: string,
  ): Promise<void>;
}

export interface HostRunnerHttpClientOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host-runner API returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function parseLeaseId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    throw new TypeError("Host-runner API returned an invalid lease.");
  }
  return value;
}

function parseRepositoryId(value: string): string {
  if (!REPOSITORY_ID.test(value)) throw new TypeError("Invalid host-runner repository ID.");
  return value;
}

function parseOperationId(value: string): string {
  if (!OPERATION_ID.test(value)) throw new TypeError("Invalid host-runner operation ID.");
  return value;
}

/** Host-side client. The service token and project capability are sent only in headers. */
export class HostRunnerHttpClient implements HostRunnerClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: HostRunnerHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:"
      || !["127.0.0.1", "[::1]", "localhost"].includes(this.baseUrl.hostname)
      || this.baseUrl.username || this.baseUrl.password || this.baseUrl.pathname !== "/") {
      throw new TypeError("Host-runner API must use an HTTP loopback URL.");
    }
    if (options.apiToken.length < 32) throw new TypeError("Host-runner API token is invalid.");
    this.fetcher = options.fetch ?? fetch;
  }

  async claim(repositoryId: string, capability: string): Promise<HostRunnerClaimV1 | undefined> {
    parseRepositoryId(repositoryId);
    const body = await this.request("/v1/host-runner/jobs/claim", {
      method: "POST",
      capability,
      body: { repositoryId },
    });
    const claim = parseObject(body).claim;
    if (claim === null) return undefined;
    const record = parseObject(claim);
    return {
      leaseId: parseLeaseId(record.leaseId),
      request: parseHarnessRunnerRequest(record.request),
    };
  }

  async ready(): Promise<boolean> {
    const body = await this.request("/health/ready", { method: "GET" });
    const ready = parseObject(body).ready;
    if (typeof ready !== "boolean") throw new TypeError("Host-runner API returned an invalid readiness response.");
    return ready;
  }

  async heartbeat(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
  ): Promise<boolean> {
    parseRepositoryId(repositoryId);
    parseOperationId(operationId);
    parseLeaseId(leaseId);
    const body = await this.request(`/v1/host-runner/jobs/${operationId}/heartbeat`, {
      method: "POST",
      capability,
      body: { repositoryId, leaseId },
    });
    const renewed = parseObject(body).renewed;
    if (typeof renewed !== "boolean") throw new TypeError("Host-runner API returned an invalid heartbeat.");
    return renewed;
  }

  async get(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
  ): Promise<HostRunnerJobStatusV1 | undefined> {
    parseRepositoryId(repositoryId);
    parseOperationId(operationId);
    parseLeaseId(leaseId);
    const query = new URLSearchParams({ repositoryId, leaseId });
    const body = await this.request(`/v1/host-runner/jobs/${operationId}?${query}`, {
      method: "GET",
      capability,
    });
    const record = parseObject(body);
    if (record.state !== "leased" || typeof record.cancelRequested !== "boolean") return undefined;
    return { state: "leased", cancelRequested: record.cancelRequested };
  }

  async complete(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
    result: HarnessRunnerResultV1,
  ): Promise<void> {
    parseRepositoryId(repositoryId);
    parseOperationId(operationId);
    parseLeaseId(leaseId);
    const body = await this.request(`/v1/host-runner/jobs/${operationId}/complete`, {
      method: "POST",
      capability,
      body: { repositoryId, leaseId, result },
    });
    if (parseObject(body).accepted !== true) throw new Error("Host-runner result was not accepted.");
  }

  async fail(
    repositoryId: string,
    capability: string,
    operationId: string,
    leaseId: string,
    message: string,
  ): Promise<void> {
    parseRepositoryId(repositoryId);
    parseOperationId(operationId);
    parseLeaseId(leaseId);
    const body = await this.request(`/v1/host-runner/jobs/${operationId}/fail`, {
      method: "POST",
      capability,
      body: { repositoryId, leaseId, message: message.slice(0, 4000) },
    });
    if (parseObject(body).accepted !== true) throw new Error("Host-runner failure was not accepted.");
  }

  private async request(
    route: string,
    input: {
      readonly method: "GET" | "POST";
      readonly capability?: string;
      readonly body?: unknown;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiToken}`,
      ...(input.capability ? { "x-forge-runner-capability": input.capability } : {}),
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    };
    let response: Response;
    try {
      response = await this.fetcher(new URL(route, this.baseUrl), {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Host-runner API request failed.");
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Host-runner API returned invalid JSON.");
    }
    if (!response.ok) {
      const error = parseObject(value).error;
      const code = error && typeof error === "object" && !Array.isArray(error)
        && typeof (error as Record<string, unknown>).code === "string"
        ? (error as Record<string, string>).code
        : "request-failed";
      throw new Error(`Host-runner API rejected the request (${code}).`);
    }
    return value;
  }
}
