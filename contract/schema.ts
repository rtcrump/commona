import { AUDIT_ACTIONS, AUDIT_RESULTS, REASON_CODES } from "./audit.js";
import { BLOCK_CATEGORIES, BLOCK_LOCATIONS } from "./guard.js";
import { NOTICE_KINDS } from "./notices.js";
import { DEFAULT_SHARING_LEVEL, SHARING_LEVELS } from "./sharing.js";
import { WAKE_STATES } from "./wake.js";

function quote(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * SQLite schema for the one M1 database.
 * Column names are snake_case. TypeScript fields are camelCase (`owner_id` ↔ `ownerId`,
 * `room_id` ↔ `room` on audit rows and `roomId` everywhere else).
 * `openDatabase` applies this string, then `SIGNING_SECRET_MIGRATIONS`.
 * `CREATE TABLE IF NOT EXISTS` does not add columns to a table that already
 * exists, so an older file would otherwise fail the first wake that reads
 * `webhook_signing_secret`. Feature modules do not invent a second schema.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('participant', 'outsider')),
  token_hash TEXT,
  -- HMAC-SHA256 needs the raw key. A hash of the secret cannot sign, so this column
  -- stores the secret itself. Do not copy it into a log, an audit row, or a response.
  webhook_signing_secret TEXT,
  -- 0 until the one-time reveal. Later reveals return null. The secret stays for signing.
  webhook_secret_revealed INTEGER NOT NULL DEFAULT 0 CHECK (webhook_secret_revealed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  webhook_url TEXT,
  event_target TEXT,
  token_hash TEXT,
  -- HMAC-SHA256 needs the raw key. A hash of the secret cannot sign, so this column
  -- stores the secret itself. Do not copy it into a log, an audit row, or a response.
  webhook_signing_secret TEXT,
  -- 0 until the one-time reveal. Later reveals return null. The secret stays for signing.
  webhook_secret_revealed INTEGER NOT NULL DEFAULT 0 CHECK (webhook_secret_revealed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by_owner_id TEXT NOT NULL REFERENCES owners(id)
);

CREATE TABLE IF NOT EXISTS memberships (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  author_owner_id TEXT NOT NULL REFERENCES owners(id),
  text TEXT NOT NULL,
  reply_to_id TEXT REFERENCES posts(id),
  thread_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  held INTEGER NOT NULL CHECK (held IN (0, 1)),
  block_category TEXT CHECK (block_category IS NULL OR block_category IN (${quote(BLOCK_CATEGORIES)})),
  block_location TEXT CHECK (block_location IS NULL OR block_location IN (${quote(BLOCK_LOCATIONS)})),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  author_owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content BLOB NOT NULL,
  metadata_json TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  held INTEGER NOT NULL CHECK (held IN (0, 1)),
  block_category TEXT CHECK (block_category IS NULL OR block_category IN (${quote(BLOCK_CATEGORIES)})),
  block_location TEXT CHECK (block_location IS NULL OR block_location IN (${quote(BLOCK_LOCATIONS)})),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sharing (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  from_owner_id TEXT NOT NULL REFERENCES owners(id),
  to_owner_id TEXT NOT NULL REFERENCES owners(id),
  level TEXT NOT NULL DEFAULT '${DEFAULT_SHARING_LEVEL}' CHECK (level IN (${quote(SHARING_LEVELS)})),
  PRIMARY KEY (room_id, from_owner_id, to_owner_id),
  CHECK (from_owner_id <> to_owner_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (${quote(AUDIT_ACTIONS)})),
  result TEXT NOT NULL CHECK (result IN (${quote(AUDIT_RESULTS)})),
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_owner ON audit_log(owner_id);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TABLE IF NOT EXISTS audit_chain_tip (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  hash TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_chain_tip_no_delete
BEFORE DELETE ON audit_chain_tip
BEGIN
  SELECT RAISE(ABORT, 'audit chain tip is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_chain_tip_forward_only
BEFORE UPDATE ON audit_chain_tip
WHEN NEW.id <> OLD.id OR NEW.seq <> OLD.seq + 1
BEGIN
  SELECT RAISE(ABORT, 'audit chain tip cannot rewind');
END;

CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
  recipient_owner_id TEXT NOT NULL REFERENCES owners(id),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  author_owner_id TEXT NOT NULL REFERENCES owners(id),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('message', 'file')),
  item_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  disclosure TEXT NOT NULL CHECK (disclosure IN ('content', 'activity_only')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${quote(WAKE_STATES)})),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN (${quote(NOTICE_KINDS)})),
  category TEXT CHECK (category IS NULL OR category IN (${quote(BLOCK_CATEGORIES)})),
  location TEXT CHECK (location IS NULL OR location IN (${quote(BLOCK_LOCATIONS)})),
  message TEXT NOT NULL,
  item_id TEXT,
  created_at TEXT NOT NULL
);
`;

/**
 * Columns added after the first M1 database file.
 * `openDatabase` runs each statement when that column is missing.
 * A row that already exists gets a null secret and `webhook_secret_revealed` 0.
 */
export const SIGNING_SECRET_MIGRATIONS = [
  {
    table: "owners",
    column: "webhook_signing_secret",
    sql: "ALTER TABLE owners ADD COLUMN webhook_signing_secret TEXT",
  },
  {
    table: "owners",
    column: "webhook_secret_revealed",
    sql: "ALTER TABLE owners ADD COLUMN webhook_secret_revealed INTEGER NOT NULL DEFAULT 0 CHECK (webhook_secret_revealed IN (0, 1))",
  },
  {
    table: "agents",
    column: "webhook_signing_secret",
    sql: "ALTER TABLE agents ADD COLUMN webhook_signing_secret TEXT",
  },
  {
    table: "agents",
    column: "webhook_secret_revealed",
    sql: "ALTER TABLE agents ADD COLUMN webhook_secret_revealed INTEGER NOT NULL DEFAULT 0 CHECK (webhook_secret_revealed IN (0, 1))",
  },
] as const;

/** Reason codes live in audit detail JSON. Exported so a drift test can see them next to the schema. */
export const SCHEMA_REASON_CODES = REASON_CODES;
