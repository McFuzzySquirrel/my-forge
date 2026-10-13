import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForHttpHealth(url, timeoutMs = 90000, requestTimeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) })).ok) return;
    } catch { /* A failed or timed-out health request is not readiness. */ }
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Sidecar readiness deadline exceeded');
}
