import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import { startConsoleServer } from "./console/server.ts";
import { CAPABILITY_TTL_MS, OperatorSessions, SESSION_IDLE_TTL_MS } from "./console/session.ts";

function rawRequest(url: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a sign-in capability is single use and expires", () => {
  let now = 0;
  const sessions = new OperatorSessions({ port: 4300, now: () => now });
  const capability = () => new URL(sessions.issueSignInUrl()).searchParams.get("capability");

  const first = capability();
  const cookie = sessions.exchange(first);
  assert.match(cookie ?? "", /^forge_console_4300=[^;]+; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(sessions.exchange(first), null);
  assert.equal(sessions.exchange(null), null);

  const late = capability();
  now += CAPABILITY_TTL_MS;
  assert.equal(sessions.exchange(late), null);
});

test("a session expires after the idle timeout and renews on use", () => {
  let now = 0;
  const sessions = new OperatorSessions({ port: 4300, now: () => now });
  const cookie = sessions.exchange(new URL(sessions.issueSignInUrl()).searchParams.get("capability"))!.split(";")[0]!;
  assert.equal(sessions.hasSession(undefined), false);
  assert.equal(sessions.hasSession("forge_console_4300=forged"), false);
  now += SESSION_IDLE_TTL_MS - 1;
  assert.equal(sessions.hasSession(`other=1; ${cookie}`), true);
  now += SESSION_IDLE_TTL_MS - 1;
  assert.equal(sessions.hasSession(cookie), true);
  now += SESSION_IDLE_TTL_MS;
  assert.equal(sessions.hasSession(cookie), false);
});

test("origin checks accept only this loopback origin", () => {
  const sessions = new OperatorSessions({ port: 4300 });
  assert.deepEqual(sessions.checkOrigin({ host: "127.0.0.1:4300" }), { ok: true });
  assert.deepEqual(sessions.checkOrigin({ host: "localhost:4300", origin: "http://localhost:4300" }), { ok: true });
  assert.equal(sessions.checkOrigin({ host: "evil.example:4300" }).ok, false);
  assert.equal(sessions.checkOrigin({ host: "127.0.0.1:4301" }).ok, false);
  assert.equal(sessions.checkOrigin({}).ok, false);
  assert.equal(sessions.checkOrigin({ host: "127.0.0.1:4300", origin: "http://evil.example" }).ok, false);
  assert.equal(sessions.checkOrigin({ host: "127.0.0.1:4300", origin: "null" }).ok, false);
});

test("the Console requires a session and rejects rebinding and cross-site requests", async (t) => {
  const logs: string[] = [];
  const server = await startConsoleServer({ port: 44950, open: false, onLog: (m) => logs.push(m) });
  t.after(() => server.stop());
  const host = new URL(server.url).host;

  assert.equal((await rawRequest(`${server.url}/api/summary`, {})).status, 401);
  assert.equal((await rawRequest(`${server.url}/api/token`, {})).status, 401);
  const page = await rawRequest(`${server.url}/`, {});
  assert.equal(page.status, 401);
  assert.doesNotMatch(page.body, /capability=/);
  assert.ok(logs.some((line) => line.includes("/session?capability=")), "a fresh link is printed to the terminal");

  const signIn = await rawRequest(server.signInUrl(), {});
  assert.equal(signIn.status, 303);
  const cookie = String((signIn.headers["set-cookie"] as string[])[0]).split(";")[0]!;

  assert.equal((await rawRequest(`${server.url}/api/summary`, { cookie })).status, 200);
  assert.equal((await rawRequest(`${server.url}/api/token`, { cookie })).status, 404);
  assert.equal((await rawRequest(`${server.url}/api/summary`, { cookie, host: `rebound.example:${new URL(server.url).port}` })).status, 421);
  assert.equal((await rawRequest(`${server.url}/api/control`, { cookie, origin: "http://evil.example", "x-forge-token": server.token }, "POST")).status, 403);
  assert.equal((await rawRequest(`${server.url}/api/control`, { cookie, origin: `http://${host}` }, "POST")).status, 403);

  assert.equal((await rawRequest(`${server.url}/api/session/logout`, { cookie }, "POST")).status, 403, "logout needs the CSRF token");
  const logout = await rawRequest(`${server.url}/api/session/logout`, { cookie, "x-forge-token": server.token }, "POST");
  assert.equal(logout.status, 200);
  assert.match(String((logout.headers["set-cookie"] as string[])[0]), /Max-Age=0/);
  assert.equal((await rawRequest(`${server.url}/api/summary`, { cookie })).status, 401);
});
