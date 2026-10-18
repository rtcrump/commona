import type Database from "better-sqlite3";

const applied = new WeakSet<Database.Database>();

/**
 * Per-agent form token for the plain room page.
 * token_hash is SHA-256 hex. The raw token is not a column.
 */
const ROOM_PAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_form_tokens (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  token_hash TEXT NOT NULL,
  PRIMARY KEY (agent_id, room_id)
);

-- The raw agent key, kept only until the clean room page is read once.
CREATE TABLE IF NOT EXISTS room_key_flash (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_key TEXT NOT NULL
);
`;

/** Apply the room page table. Safe to call more than once on the same database. */
export function ensureRoomPageSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  db.exec(ROOM_PAGE_SCHEMA_SQL);
  applied.add(db);
}
