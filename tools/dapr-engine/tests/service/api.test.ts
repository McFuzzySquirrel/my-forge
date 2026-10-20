import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServiceApiHandler, isLoopbackHost, type RunServiceApi } from "../../service/api.ts";

const TOKEN = "a".repeat(64);
const RUN_ID = `run_${"0".repeat(32)}`;

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function start(t: test.TestContext, overrides: Partial<RunServiceApi> = {}, ready = true): Promise<{ port: number; calls: string[] }> {
  const calls: string[] = [];
  const ok = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    return { ok: true as const, status: 200, body: { called: name } };
  };
  const runs: RunServiceApi = {
    submit: ok("submit"), list: ok("list"), get: ok("get"), events: ok("events"), control: ok("control"),
    ...overrides,
  };
  const server: Server = createServer(createServiceApiHandler({
    token: TOKEN,
    runs,
    health: () => ({ live: true, ready }),
    maxBodyBytes: 1024,
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, calls };
}

function send(port: number, options: {
  method?: string; path: string; headers?: Record<string, string>; body?: string;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: options.method ?? "GET",
      path: options.path,
      headers: { host: `127.0.0.1:${port}`, ...options.headers },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    request.once("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

test("health probes are unauthenticated and reflect readiness", async (t) => {
  const { port } = await start(t, {}, false);
  assert.equal((await send(port, { path: "/health/live" })).status, 200);
  assert.equal((await send(port, { path: "/health/ready" })).status, 503);
  assert.equal((await send(port, { path: "/v1/runs", headers: auth })).status, 503);
});

test("API requires a bearer token compared in constant time", async (t) => {
  const { port, calls } = await start(t);
  assert.equal((await send(port, { path: "/v1/runs" })).status, 401);
  assert.equal((await send(port, { path: "/v1/runs", headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status, 401);
  assert.equal((await send(port, { path: "/v1/runs", headers: { authorization: TOKEN } })).status, 401);
  assert.equal(calls.length, 0);
  const listed = await send(port, { path: "/v1/runs?limit=5&repositoryId=demo", headers: auth });
  assert.equal(listed.status, 200);
  assert.deepEqual(calls, ['list:[5,"demo"]']);
});

test("API rejects non-loopback hosts and browser origins before authentication", async (t) => {
  const { port, calls } = await start(t);
  const rebinding = await send(port, { path: "/v1/runs", headers: { ...auth, host: "attacker.example:8483" } });
  assert.equal(rebinding.status, 421);
  const browser = await send(port, { path: "/v1/runs", headers: { ...auth, origin: "http://127.0.0.1:8483" } });
  assert.equal(browser.status, 403);
  assert.equal((browser.body.error as { code: string }).code, "browser-origin-rejected");
  assert.equal(calls.length, 0);
  assert.equal(isLoopbackHost("[::1]:8483"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1.nip.io"), false);
});

test("API validates JSON bodies, media types, and size limits", async (t) => {
  const { port, calls } = await start(t);
  const json = { ...auth, "content-type": "application/json" };
  assert.equal((await send(port, { method: "POST", path: "/v1/runs", headers: auth, body: "{}" })).status, 415);
  assert.equal((await send(port, { method: "POST", path: "/v1/runs", headers: json, body: "{" })).status, 400);
  assert.equal((await send(port, { method: "POST", path: "/v1/runs", headers: json, body: JSON.stringify({ x: "y".repeat(2048) }) })).status, 413);
  const submitted = await send(port, { method: "POST", path: "/v1/runs", headers: json, body: '{"a":1}' });
  assert.equal(submitted.status, 200);
  assert.deepEqual(calls, ['submit:[{"a":1}]']);
});

test("API routes run status, events, and controls by run ID", async (t) => {
  const { port, calls } = await start(t);
  assert.equal((await send(port, { path: `/v1/runs/${RUN_ID}`, headers: auth })).status, 200);
  assert.equal((await send(port, { path: `/v1/runs/${RUN_ID}/events?after=3&limit=10`, headers: auth })).status, 200);
  assert.equal((await send(port, {
    method: "POST", path: `/v1/runs/${RUN_ID}/controls`, headers: { ...auth, "content-type": "application/json" }, body: '{"action":"pause"}',
  })).status, 200);
  assert.deepEqual(calls, [
    `get:["${RUN_ID}"]`,
    `events:["${RUN_ID}",3,10]`,
    `control:["${RUN_ID}",{"action":"pause"}]`,
  ]);
  assert.equal((await send(port, { path: "/v1/runs/run_../events", headers: auth })).status, 404);
  assert.equal((await send(port, { method: "DELETE", path: `/v1/runs/${RUN_ID}`, headers: auth })).status, 405);
});

test("API maps service rejections and hides internal errors", async (t) => {
  const { port } = await start(t, {
    get: async () => ({ ok: false, status: 404, code: "unknown-run", detail: "missing" }),
    events: async () => { throw new Error("database password leaked"); },
  });
  const missing = await send(port, { path: `/v1/runs/${RUN_ID}`, headers: auth });
  assert.deepEqual([missing.status, (missing.body.error as { code: string }).code], [404, "unknown-run"]);
  const failed = await send(port, { path: `/v1/runs/${RUN_ID}/events`, headers: auth });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /password/);
});

test("API refuses short tokens", () => {
  assert.throws(() => createServiceApiHandler({
    token: "short",
    runs: {} as RunServiceApi,
    health: () => ({ live: true, ready: true }),
  }), /at least 32/);
});
