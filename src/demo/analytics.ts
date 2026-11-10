/**
 * Opt-in hook for Cloudflare Web Analytics.
 * The beacon is added only when a site token is configured, and only on the
 * fixed HTML pages. No account is created here. The token is a site id, not
 * a person, and it is never copied into the visible page text.
 */

export const DEMO_HTML_PATHS = ["/", "/demo", "/demo/privacy"] as const;
export const DEMO_ASSET_PATHS = ["/demo/demo.css", "/demo/replay.js"] as const;
export const DEMO_HEALTH_PATHS = ["/health", "/demo/health"] as const;

const HTML_PATHS = new Set<string>(DEMO_HTML_PATHS);

/** Site token shape. Rejects spaces, query strings, and markup. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
export const BEACON_CONNECT = "https://cloudflareinsights.com";

export function analyticsToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

export function pageGetsBeacon(path: string, token: string | null): token is string {
  return token !== null && HTML_PATHS.has(path);
}

/** Beacon JSON is only the site token and the documented spa switch. */
export function beaconPayload(token: string): { token: string; spa: false } {
  return { token, spa: false };
}

export function beaconMarkup(token: string): string {
  const json = JSON.stringify(beaconPayload(token));
  return `<script defer src="${BEACON_SRC}" data-cf-beacon="${json.replaceAll('"', "&quot;")}"></script>`;
}

export function contentSecurityPolicy(beacon: boolean): string {
  const script = beacon ? `script-src 'self' ${BEACON_SRC}` : "script-src 'self'";
  const connect = beacon ? `connect-src ${BEACON_CONNECT}` : "connect-src 'none'";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    script,
    connect,
  ].join("; ");
}
