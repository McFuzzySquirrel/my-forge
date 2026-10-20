// Test helper: starts a Console server and signs in, so tests exercise the
// API through an operator session exactly as a browser would.
import { startConsoleServer, type ConsoleServer, type ConsoleServerOptions } from "./console/server.ts";

const cookies = new Map<string, string>();

export async function signIn(server: ConsoleServer): Promise<string> {
  const response = await globalThis.fetch(server.signInUrl(), { redirect: "manual" });
  const setCookie = response.headers.get("set-cookie");
  if (response.status !== 303 || !setCookie) throw new Error(`sign-in failed: ${response.status}`);
  return setCookie.split(";")[0]!;
}

export async function startSignedConsoleServer(options: ConsoleServerOptions = {}): Promise<ConsoleServer> {
  const server = await startConsoleServer(options);
  cookies.set(new URL(server.url).origin, await signIn(server));
  return server;
}

export function sessionHeaders(url: string): Record<string, string> {
  const cookie = cookies.get(new URL(url).origin);
  return cookie ? { cookie } : {};
}

export const signedFetch = (input: string | URL, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(sessionHeaders(String(input)))) headers.set(name, value);
  return globalThis.fetch(input, { ...init, headers });
};
