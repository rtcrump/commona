/**
 * Invite links must be a URL the browser will treat as a secure context.
 * A non-local `http` page drops the `Secure` invite cookie, so accept never
 * sees it. Loopback is the exception browsers already allow.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/** A same-machine TLS terminator. A remote client is not in this list, so it cannot spoof X-Forwarded-*. */
export const DEFAULT_TRUST_PROXY = "127.0.0.1,::1";

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (LOOPBACK.has(trimmed)) return true;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return false;
    return LOOPBACK.has(trimmed.slice(1, end));
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > -1 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return LOOPBACK.has(trimmed.slice(0, colon));
  }
  return false;
}

/** `COMMONA_PUBLIC_ORIGIN`, or an explicit test value. Empty means derive from the request. */
export function publicOriginSetting(explicit: string | undefined, env: string | undefined): string | undefined {
  const raw = explicit !== undefined ? explicit : env;
  if (raw === undefined || raw.trim() === "") return undefined;
  return parsePublicOrigin(raw.trim());
}

export function parsePublicOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("COMMONA_PUBLIC_ORIGIN is not an absolute URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("COMMONA_PUBLIC_ORIGIN cannot include credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("COMMONA_PUBLIC_ORIGIN must be an origin with no path");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("COMMONA_PUBLIC_ORIGIN must be http or https");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("COMMONA_PUBLIC_ORIGIN must use https for a host outside loopback");
  }
  return url.origin;
}

/**
 * `COMMONA_TRUST_PROXY`: `false` trusts nobody, `true` trusts every peer,
 * and any other value is a Fastify address list. Unset trusts loopback only.
 */
export function trustProxySetting(explicit: boolean | string | undefined, env: string | undefined): boolean | string {
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "string") return parseTrustProxy(explicit);
  return parseTrustProxy(env ?? "");
}

function parseTrustProxy(raw: string): boolean | string {
  const value = raw.trim();
  if (value === "") return DEFAULT_TRUST_PROXY;
  if (value === "false" || value === "0") return false;
  if (value === "true") return true;
  if (!/^[0-9A-Za-z.:%,_\- ]+$/.test(value)) {
    throw new Error("COMMONA_TRUST_PROXY is not a proxy address list");
  }
  return value;
}

export function inviteOrigin(input: { configured?: string; host?: string; protocol?: string }): string {
  if (input.configured) return input.configured;
  const host = input.host && HOST_RE.test(input.host) ? input.host : "127.0.0.1";
  const https = input.protocol?.trim().toLowerCase() === "https" || !isLoopbackHost(host);
  return `${https ? "https" : "http"}://${host}`;
}
