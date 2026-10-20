import { randomBytes } from "node:crypto";

// ADR-070: the Console trusts the local OS user. Whoever can read the terminal
// running `forge-launcher console` receives a one-time sign-in capability; the
// browser exchanges it for an expiring, HttpOnly session cookie. No GitHub or
// harness login is involved.

export const SIGN_IN_PATH = "/session";
export const CAPABILITY_TTL_MS = 10 * 60_000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60_000;
const MAX_PENDING_CAPABILITIES = 5;

export interface OperatorSessionOptions {
  port: number;
  now?: () => number;
}

export type RequestAccess =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 421; reason: string };

export class OperatorSessions {
  readonly cookieName: string;
  private readonly port: number;
  private readonly now: () => number;
  private readonly capabilities = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(options: OperatorSessionOptions) {
    this.port = options.port;
    this.now = options.now ?? Date.now;
    // Browsers do not isolate cookies by port, so two Consoles on one host must
    // not overwrite each other's session.
    this.cookieName = `forge_console_${options.port}`;
  }

  /** Mints a single-use sign-in link. */
  issueSignInUrl(): string {
    const now = this.now();
    this.prune(now);
    while (this.capabilities.size >= MAX_PENDING_CAPABILITIES) {
      const oldest = this.capabilities.keys().next().value as string;
      this.capabilities.delete(oldest);
    }
    const capability = randomBytes(32).toString("base64url");
    this.capabilities.set(capability, now + CAPABILITY_TTL_MS);
    return `http://127.0.0.1:${this.port}${SIGN_IN_PATH}?capability=${capability}`;
  }

  /** Consumes a capability and returns the Set-Cookie value for a new session. */
  exchange(capability: string | null): string | null {
    const now = this.now();
    this.prune(now);
    if (!capability || !this.capabilities.has(capability)) return null;
    this.capabilities.delete(capability);
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, now + SESSION_IDLE_TTL_MS);
    return `${this.cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /** True when the request carries a live session; renews its idle expiry. */
  hasSession(cookieHeader: string | undefined): boolean {
    const session = readCookie(cookieHeader, this.cookieName);
    if (!session) return false;
    const now = this.now();
    const expiresAt = this.sessions.get(session);
    if (expiresAt === undefined || expiresAt <= now) {
      this.sessions.delete(session);
      return false;
    }
    this.sessions.set(session, now + SESSION_IDLE_TTL_MS);
    return true;
  }

  /** Ends the request's session; returns the Set-Cookie value that clears it. */
  revoke(cookieHeader: string | undefined): string {
    const session = readCookie(cookieHeader, this.cookieName);
    if (session) this.sessions.delete(session);
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  /**
   * Rejects requests that did not come from this loopback origin. The Host
   * check defeats DNS rebinding; the Origin check rejects cross-site requests
   * a browser would otherwise send with the session cookie.
   */
  checkOrigin(headers: { host?: string; origin?: string }): RequestAccess {
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!headers.host || !allowed.includes(headers.host.toLowerCase())) {
      return { ok: false, status: 421, reason: "unexpected Host header" };
    }
    if (headers.origin !== undefined && !allowed.some((host) => headers.origin!.toLowerCase() === `http://${host}`)) {
      return { ok: false, status: 403, reason: "cross-origin request rejected" };
    }
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [capability, expiresAt] of this.capabilities) {
      if (expiresAt <= now) this.capabilities.delete(capability);
    }
    for (const [session, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(session);
    }
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}
