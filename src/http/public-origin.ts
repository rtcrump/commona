/**
 * Origin for links an agent calls back. The same rule builds invite links.
 * A configured COMMONA_PUBLIC_ORIGIN wins. Otherwise the request host is used,
 * and only localhost may stay on http.
 */
export function publicOrigin(url: string, hostHeader: string | undefined): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const host = hostHeader ?? "localhost";
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "http://localhost";
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (name !== "localhost" && name !== "127.0.0.1") return `https://${host}`;
  const protocol = new URL(url).protocol === "https:" ? "https" : "http";
  return `${protocol}://${host}`;
}

function configuredPublicOrigin(): string | undefined {
  const raw = process.env.COMMONA_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(raw)) return raw;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(raw)) return raw;
  throw new Error("COMMONA_PUBLIC_ORIGIN must be an https origin");
}
