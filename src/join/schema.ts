import type Database from "better-sqlite3";

const applied = new WeakSet<Database.Database>();

/**
 * Invite tables. Inlined so the compiled server does not read a file `tsc` never emits.
 * The raw invite secret, agent credential, and handoff secret are never columns.
 * secret_hash is SHA-256 (hex), the same hash as bearer tokens.
 */
export const INVITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  secret_hash TEXT NOT NULL,
  created_by_owner_id TEXT NOT NULL REFERENCES owners(id),
  created_by_agent_id TEXT REFERENCES agents(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_agents (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
`;

/** Apply the invite migration. Safe to call more than once on the same database. */
export function ensureInviteSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  db.exec(INVITE_SCHEMA_SQL);
  applied.add(db);
}
