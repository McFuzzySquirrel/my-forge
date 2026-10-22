import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseHarnessRunnerResult } from "../execution/runner-contract.ts";
import type {
  HostRunnerClaimV1,
  HostRunnerJobV1,
} from "../storage/postgres/host-runner-jobs.ts";
import type { RunServiceResult } from "./runs.ts";

const REPOSITORY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
export const HOST_RUNNER_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const HOST_RUNNER_LEASE_MS = 30_000;

function reject(status: number, code: string, detail: string): RunServiceResult {
  return { ok: false, status, code, detail };
}

function success(body: unknown, status = 200): RunServiceResult {
  return { ok: true, status, body };
}

function parseCapability(value: string): Buffer | undefined {
  if (!CAPABILITY.test(value)) return undefined;
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(
  repositoryId: string,
  capability: string,
  hashes: ReadonlyMap<string, string>,
): boolean {
  if (!REPOSITORY_ID.test(repositoryId)) return false;
  const candidate = parseCapability(capability);
  const expectedValue = hashes.get(repositoryId);
  if (!candidate || !expectedValue || !/^sha256:[0-9a-f]{64}$/.test(expectedValue)) return false;
  const expected = Buffer.from(expectedValue.slice(7), "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

export interface HostRunnerServiceOptions {
  readonly jobs: HostRunnerJobStore;
  readonly capabilityHashes: ReadonlyMap<string, string>;
}

export interface HostRunnerJobStore {
  claim(repositoryId: string, leaseMs: number): Promise<HostRunnerClaimV1 | undefined>;
  heartbeat(operationId: string, leaseId: string, leaseMs: number): Promise<boolean>;
  getForRunner(operationId: string, repositoryId: string, leaseId: string): Promise<HostRunnerJobV1 | undefined>;
  complete(operationId: string, leaseId: string, result: unknown): Promise<boolean>;
  fail(operationId: string, leaseId: string, message: string): Promise<boolean>;
  cancel(operationId: string): Promise<boolean>;
}

export function parseHostRunnerCapabilityHashes(value: unknown): Map<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host-runner capability hash file has an invalid schema.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.capabilities === null || typeof record.capabilities !== "object"
    || Array.isArray(record.capabilities)) {
    throw new TypeError("Host-runner capability hash file has an invalid schema.");
  }
  const hashes = new Map<string, string>();
  for (const [repositoryId, hash] of Object.entries(record.capabilities)) {
    if (!REPOSITORY_ID.test(repositoryId) || typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new TypeError("Host-runner capability hash file contains an invalid entry.");
    }
    hashes.set(repositoryId, hash);
  }
  return hashes;
}

export async function loadHostRunnerCapabilityHashes(file: string | undefined): Promise<Map<string, string>> {
  if (!file) return new Map();
  try {
    return parseHostRunnerCapabilityHashes(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

/** Authenticated operations exposed only to the per-project host runner. */
export class HostRunnerService {
  constructor(private readonly options: HostRunnerServiceOptions) {}

  async claim(repositoryId: string, capability: string): Promise<RunServiceResult> {
    if (!authorized(repositoryId, capability, this.options.capabilityHashes)) {
      return reject(403, "runner-capability-rejected", "The host-runner capability is invalid or revoked.");
    }
    const claim = await this.options.jobs.claim(repositoryId, HOST_RUNNER_LEASE_MS);
    return success({ claim: claim ?? null });
  }

  async heartbeat(
    repositoryId: string,
    operationId: string,
    leaseId: string,
    capability: string,
  ): Promise<RunServiceResult> {
    if (!authorized(repositoryId, capability, this.options.capabilityHashes)) {
      return reject(403, "runner-capability-rejected", "The host-runner capability is invalid or revoked.");
    }
    if (!OPERATION_ID.test(operationId) || !OPERATION_ID.test(leaseId)) {
      return reject(400, "invalid-request", "The operation or lease identity is invalid.");
    }
    const renewed = await this.options.jobs.heartbeat(operationId, leaseId, HOST_RUNNER_LEASE_MS);
    return success({ renewed });
  }

  async get(
    repositoryId: string,
    operationId: string,
    leaseId: string,
    capability: string,
  ): Promise<RunServiceResult> {
    if (!authorized(repositoryId, capability, this.options.capabilityHashes)) {
      return reject(403, "runner-capability-rejected", "The host-runner capability is invalid or revoked.");
    }
    if (!OPERATION_ID.test(operationId) || !OPERATION_ID.test(leaseId)) {
      return reject(400, "invalid-request", "The operation or lease identity is invalid.");
    }
    const job = await this.options.jobs.getForRunner(operationId, repositoryId, leaseId);
    if (!job) return reject(404, "unknown-runner-job", "The host-runner lease is no longer active.");
    return success({ state: job.state, cancelRequested: job.cancelRequested });
  }

  async complete(
    repositoryId: string,
    operationId: string,
    leaseId: string,
    capability: string,
    value: unknown,
  ): Promise<RunServiceResult> {
    if (!authorized(repositoryId, capability, this.options.capabilityHashes)) {
      return reject(403, "runner-capability-rejected", "The host-runner capability is invalid or revoked.");
    }
    if (!OPERATION_ID.test(operationId) || !OPERATION_ID.test(leaseId)) {
      return reject(400, "invalid-request", "The operation or lease identity is invalid.");
    }
    const job = await this.options.jobs.getForRunner(operationId, repositoryId, leaseId);
    if (!job) return reject(404, "unknown-runner-job", "The host-runner lease is no longer active.");
    if (job.cancelRequested) {
      await this.options.jobs.cancel(operationId);
      return reject(409, "runner-job-cancelled", "The Dapr execution cancelled this host-runner job.");
    }
    let result: ReturnType<typeof parseHarnessRunnerResult>;
    try {
      result = parseHarnessRunnerResult(
        job.request,
        value,
        HOST_RUNNER_MAX_RESULT_BYTES,
      );
    } catch (error) {
      return reject(422, "invalid-runner-result", error instanceof Error ? error.message : "The host-runner result is invalid.");
    }
    const completed = await this.options.jobs.complete(operationId, leaseId, result);
    return completed
      ? success({ accepted: true })
      : reject(409, "runner-lease-lost", "The host-runner lease expired or the job was cancelled.");
  }

  async fail(
    repositoryId: string,
    operationId: string,
    leaseId: string,
    capability: string,
    message: string,
  ): Promise<RunServiceResult> {
    if (!authorized(repositoryId, capability, this.options.capabilityHashes)) {
      return reject(403, "runner-capability-rejected", "The host-runner capability is invalid or revoked.");
    }
    if (!OPERATION_ID.test(operationId) || !OPERATION_ID.test(leaseId)) {
      return reject(400, "invalid-request", "The operation or lease identity is invalid.");
    }
    if (typeof message !== "string" || message.length > 4000) {
      return reject(400, "invalid-request", "Failure details must be a string of at most 4000 characters.");
    }
    const failed = await this.options.jobs.fail(operationId, leaseId, message);
    return failed
      ? success({ accepted: true })
      : reject(409, "runner-lease-lost", "The host-runner lease expired or the job was cancelled.");
  }

}
