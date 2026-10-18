import type Database from "better-sqlite3";

const applied = new WeakSet<Database.Database>();

/**
 * Revoked agent keys and the hourly post window.
 * token_hash is SHA-256 hex. The raw key is not a column.
 * Both tables live in the room database, which is Durable Object SQLite on Cloudflare.
 */
const AGENT_API_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_key_revocations (
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, room_id)
);
CREATE INDEX IF NOT EXISTS agent_key_revocations_hash ON agent_key_revocations (token_hash);

CREATE TABLE IF NOT EXISTS agent_post_hits (
  agent_id TEXT NOT NULL,
  posted_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_post_hits_agent ON agent_post_hits (agent_id, posted_ms);
`;

/** Apply the agent API tables. Safe to call more than once on the same database. */
export function ensureAgentApiSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  db.exec(AGENT_API_SCHEMA_SQL);
  applied.add(db);
}
