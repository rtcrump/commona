/**
 * Origin for links an agent calls back. The same rule builds invite links.
 * A configured COMMONA_PUBLIC_ORIGIN wins. Otherwise the request host is used,
 * and only localhost may stay on http.
 * The result is a clean absolute origin: lowercase host, no path, no trailing
 * slash, and no explicit default port. A value the URL parser would rewrite
 * (a different host, a path, a missing scheme) is refused.
 */
export const PUBLIC_ORIGIN_MESSAGE = "COMMONA_PUBLIC_ORIGIN must be an https origin";

export class PublicOriginError extends Error {
  constructor() {
    super(PUBLIC_ORIGIN_MESSAGE);
    this.name = "PublicOriginError";
  }
}

const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;
const LOCAL = /^(?:localhost|127\.0\.0\.1)$/;

export function publicOrigin(url: string, hostHeader: string | undefined): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const host = hostHeader?.trim() || "localhost";
  if (!HOST.test(host)) return "http://localhost";
  const name = host.replace(/:\d+$/, "").toLowerCase();
  let scheme = "https";
  if (LOCAL.test(name)) {
    try {
      scheme = new URL(url).protocol === "https:" ? "https" : "http";
    } catch {
      scheme = "http";
    }
  }
  return normalizeOrigin(`${scheme}://${host}`) ?? "http://localhost";
}

function configuredPublicOrigin(): string | undefined {
  const raw = process.env.COMMONA_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  const normalized = normalizeOrigin(raw);
  if (!normalized) throw new PublicOriginError();
  return normalized;
}

/**
 * Clean absolute origin, or undefined when the value is not one.
 * One trailing slash is removed. The host is lowercased. :443 and :80 are
 * dropped only when they are the scheme's default port.
 */
export function normalizeOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  const bare = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (!bare || bare.endsWith("/")) return undefined;
  const match = /^(https?):\/\/([^/?#\\]+)$/.exec(bare);
  const scheme = match?.[1];
  const hostport = match?.[2];
  if ((scheme !== "https" && scheme !== "http") || !hostport || !HOST.test(hostport)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${hostport}`);
  } catch {
    return undefined;
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return undefined;
  }
  const lowered = hostport.toLowerCase();
  const defaultPort = scheme === "https" ? "443" : "80";
  const suffix = `:${defaultPort}`;
  const expectedHost = lowered.endsWith(suffix) ? lowered.slice(0, -suffix.length) : lowered;
  if (expectedHost.length === 0 || parsed.host !== expectedHost) return undefined;
  if (scheme === "http" && !LOCAL.test(parsed.hostname)) return undefined;
  return parsed.origin;
}
