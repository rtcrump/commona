import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../contract/index.js";

/**
 * Owner filter rows. Not part of SCHEMA_SQL. The contract schema stays put.
 * A missing row fails closed at check time. `ensureDefaultPrivacyFilter`
 * writes the default for a new owner.
 */
const PRIVACY_FILTER_SQL = `
CREATE TABLE IF NOT EXISTS privacy_filters (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  // WAL lets the harness open the same file while the server is running.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  db.exec(PRIVACY_FILTER_SQL);
  return db;
}
