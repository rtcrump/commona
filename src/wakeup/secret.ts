import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { ContractError } from "../../contract/index.js";

type Sqlite = Database.Database;
type PrincipalKind = "owner" | "agent";

/**
 * Webhook signing secrets for owners and agents.
 *
 * HMAC-SHA256 needs the raw key. Hashing the secret, the way bearer tokens are
 * hashed, would make signing impossible. `webhook_signing_secret` is therefore
 * the secret itself. Do not put it in a log line, an audit row, or an HTTP response.
 *
 * The secret is generated when the row first needs one, so the server can sign
 * before anyone asks for it. {@link revealWebhookSigningSecret} is the one-time
 * handoff, same shape as the agent token on first join: the first call returns
 * the raw value, and later calls return null. The row is not cleared, because
 * the server still has to sign.
 */
export function signingSecretFor(db: Sqlite, kind: PrincipalKind, id: string): string {
  const readAndMaybeCreate = db.transaction(() => {
    const row = readSecret(db, kind, id);
    if (row.secret) return row.secret;
    const secret = newWebhookSecret();
    writeSecret(db, kind, id, secret);
    return secret;
  });
  return readAndMaybeCreate();
}

/**
 * Returns the secret once. A second call returns null even though the row still holds it.
 * This is not an HTTP response. Join bodies do not include the secret.
 */
export function revealWebhookSigningSecret(db: Sqlite, kind: PrincipalKind, id: string): string | null {
  const reveal = db.transaction(() => {
    const row = readSecret(db, kind, id);
    const secret = row.secret ?? newWebhookSecret();
    if (!row.secret) writeSecret(db, kind, id, secret);
    if (row.revealed === 1) return null;
    markRevealed(db, kind, id);
    return secret;
  });
  return reveal();
}

function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function readSecret(db: Sqlite, kind: PrincipalKind, id: string): { secret: string | null; revealed: number } {
  const sql =
    kind === "owner"
      ? "SELECT webhook_signing_secret AS secret, webhook_secret_revealed AS revealed FROM owners WHERE id = ?"
      : "SELECT webhook_signing_secret AS secret, webhook_secret_revealed AS revealed FROM agents WHERE id = ?";
  const row = db.prepare(sql).get(id) as { secret: string | null; revealed: number } | undefined;
  if (!row) {
    throw new ContractError(kind === "owner" ? "unknown owner" : "wake recipient is missing");
  }
  return row;
}

function writeSecret(db: Sqlite, kind: PrincipalKind, id: string, secret: string): void {
  const sql =
    kind === "owner"
      ? "UPDATE owners SET webhook_signing_secret = ? WHERE id = ?"
      : "UPDATE agents SET webhook_signing_secret = ? WHERE id = ?";
  db.prepare(sql).run(secret, id);
}

function markRevealed(db: Sqlite, kind: PrincipalKind, id: string): void {
  const sql =
    kind === "owner"
      ? "UPDATE owners SET webhook_secret_revealed = 1 WHERE id = ?"
      : "UPDATE agents SET webhook_secret_revealed = 1 WHERE id = ?";
  db.prepare(sql).run(id);
}
