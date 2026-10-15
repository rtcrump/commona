import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../contract/index.js";
import { PRIVACY_FILTER_SQL } from "./guard/filter-store.js";

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
