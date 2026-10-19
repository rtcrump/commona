import type Database from "better-sqlite3";

/** Keyset index for the plain room page: unheld posts in one room, newest first. */
export const POSTS_RECENT_INDEX = "posts_room_held_recent";

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

-- SHA-256 of the owner token, kept until the clean room page shows that token once.
-- The raw owner token is not a column.
CREATE TABLE IF NOT EXISTS room_owner_flash (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  token_hash TEXT NOT NULL
);

-- Newest unheld posts in one room, for the keyset on (created_at, id).
CREATE INDEX IF NOT EXISTS ${POSTS_RECENT_INDEX}
ON posts (room_id, held, created_at, id);
`;

/** Apply the room page table. Safe to call more than once on the same database. */
export function ensureRoomPageSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  db.exec(ROOM_PAGE_SCHEMA_SQL);
  applied.add(db);
}
