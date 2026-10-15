/**
 * The raw invite secret exists only until the first GET sets the cookie.
 * The database stores the SHA-256 hash. This map is process memory for the
 * single M1 server, and the entry is removed when the cookie is set.
 */
const pending = new Map<string, string>();

export function holdInviteSecret(id: string, secret: string): void {
  pending.set(id, secret);
}

export function takeInviteSecret(id: string): string | null {
  const secret = pending.get(id);
  if (secret === undefined) return null;
  pending.delete(id);
  return secret;
}

export function dropInviteSecret(id: string): void {
  pending.delete(id);
}
