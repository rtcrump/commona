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

/** Apply the room schema, signing-secret columns, and the poll table. */
export function prepareDatabase(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  for (const step of SIGNING_SECRET_MIGRATIONS) {
    const rows = db.prepare(`PRAGMA table_info(${step.table})`).all() as { name: string }[];
    if (rows.some((row) => row.name === step.column)) continue;
    db.exec(step.sql);
  }
  db.exec(POLL_SQL);
}
