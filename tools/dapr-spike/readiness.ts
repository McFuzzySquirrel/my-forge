import { setTimeout as sleep } from "node:timers/promises";

export async function waitForHttpHealth(
  url: string,
  timeoutMs = 90_000,
  requestTimeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) })).ok) return;
    } catch {
      // A failed or timed-out health request is not readiness.
    }
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Sidecar readiness deadline exceeded");
}
