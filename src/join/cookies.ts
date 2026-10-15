export const INVITE_COOKIE = "commona_invite";
export const SESSION_COOKIE = "commona_session";
export const FORM_COOKIE = "commona_form";
export const JOINED_COOKIE = "commona_joined";

export function serializeCookie(name: string, value: string, path: string, maxAge?: number): string {
  const age = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}${age}`;
}

export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  return value;
}
