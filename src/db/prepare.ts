import type Database from "better-sqlite3";
import { SCHEMA_SQL, SIGNING_SECRET_MIGRATIONS } from "../../contract/index.js";

/**
 * Poll marks sit beside the room schema. They are not part of the shared contract.
 * The column stores a hash of the agent key, never the key itself.
 */
const POLL_SQL = `
CREATE TABLE IF NOT EXISTS agent_polls (
  token_hash TEXT PRIMARY KEY,
  last_ms INTEGER NOT NULL
);
`;

/**
 * Next webhook attempt for the Worker. The Node server sleeps inside deliver().
 * A Durable Object cannot hold the request across the 2s, 8s, and 20s gaps, so the
 * alarm reads this table. It is not part of the shared contract schema.
 */
const WAKE_ALARM_SQL = `
CREATE TABLE IF NOT EXISTS wake_alarms (
  wake_id TEXT PRIMARY KEY,
  due_ms INTEGER NOT NULL
);
`;

/**
 * Insertion order for posts and files. The loop round reads this, not the
 * random id, so two items with the same timestamp stay in the order written.
 */
const ITEM_ORDER_SQL = `
CREATE TABLE IF NOT EXISTS room_item_seq (
  seq INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE
);
`;

/** Apply the room schema, signing-secret columns, and the poll table. */
export function prepareDatabase(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  for (const step of SIGNING_SECRET_MIGRATIONS) {
    const rows = db.prepare(`PRAGMA table_info(${step.table})`).all() as { name: string }[];
    if (rows.some((row) => row.name === step.column)) continue;
    db.exec(step.sql);
  }
  db.exec(POLL_SQL);
  db.exec(WAKE_ALARM_SQL);
  db.exec(ITEM_ORDER_SQL);
  backfillItemOrder(db);
}

function backfillItemOrder(db: Database.Database): void {
  const missing = db
    .prepare(
      `SELECT id FROM (
         SELECT id, created_at FROM posts
         UNION ALL
         SELECT id, created_at FROM files
       )
       WHERE id NOT IN (SELECT item_id FROM room_item_seq)
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as { id: string }[];
  if (missing.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO room_item_seq (seq, item_id)
     SELECT COALESCE(MAX(seq), 0) + 1, ? FROM room_item_seq`,
  );
  const write = db.transaction(() => {
    for (const row of missing) insert.run(row.id);
  });
  write();
}
