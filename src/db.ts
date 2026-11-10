import type Database from "better-sqlite3";
import { createSqliteDatabase } from "./db/adapter.js";
import { openNodeDriver } from "./db/node-driver.js";
import { prepareDatabase } from "./db/prepare.js";

/**
 * Open the Node database. The Worker does not call this.
 * Node 22 needs `--experimental-sqlite` before the process starts.
 */
export function openDatabase(path: string): Database.Database {
  const db = createSqliteDatabase(openNodeDriver(path));
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // A memory database may ignore WAL.
  }
  db.pragma("foreign_keys = ON");
  try {
    db.pragma("busy_timeout = 5000");
  } catch {
    // busy_timeout is a Node file-database setting.
  }
  prepareDatabase(db);
  return db;
}
