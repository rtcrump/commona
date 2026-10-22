import type Database from "better-sqlite3";

const applied = new WeakSet<Database.Database>();

/**
 * Invite and connect tables. Inlined so the compiled server does not read a file `tsc` never emits.
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

-- Short display name for the join page. Never a room id, and never post or file text.
CREATE TABLE IF NOT EXISTS room_titles (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  title TEXT NOT NULL
);

-- Which room a connect link was issued for. The handoff secret stays a hash on agent_handoffs.
-- bound_at is set after the first successful handoff. Claude reconnects with that same link.
CREATE TABLE IF NOT EXISTS connect_links (
  handoff_id TEXT PRIMARY KEY REFERENCES agent_handoffs(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  invite_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bound_at TEXT
);

-- The agent's own check-in. Not a room post.
CREATE TABLE IF NOT EXISTS connect_presence (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  checked_in_at TEXT NOT NULL
);

-- A Check connection click waits for the agent to answer one of these.
CREATE TABLE IF NOT EXISTS connect_pings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  requested_at TEXT NOT NULL,
  answered_at TEXT
);

-- Who finished this invite. Lets that owner open Connect after the join cookie is gone.
CREATE TABLE IF NOT EXISTS invite_owners (
  invite_id TEXT PRIMARY KEY REFERENCES invites(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  room_id TEXT NOT NULL REFERENCES rooms(id)
);

-- First name typed on the join page, kept until finish. The raw invite secret is not a column.
CREATE TABLE IF NOT EXISTS invite_pending_names (
  invite_id TEXT PRIMARY KEY REFERENCES invites(id),
  secret_hash TEXT NOT NULL,
  first_name TEXT NOT NULL
);
`;

/** Apply the invite migration. Safe to call more than once on the same database. */
export function ensureInviteSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  db.exec(INVITE_SCHEMA_SQL);
  ensureConnectBindingColumn(db);
  applied.add(db);
}

/** Older databases created the connect table before a link could stay bound. */
function ensureConnectBindingColumn(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(connect_links)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "bound_at")) {
    db.exec("ALTER TABLE connect_links ADD COLUMN bound_at TEXT");
  }
}
