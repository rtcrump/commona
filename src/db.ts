import Database from "better-sqlite3";
import { SCHEMA_SQL, SIGNING_SECRET_MIGRATIONS } from "../contract/index.js";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  // WAL lets the harness open the same file while the server is running.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  applySigningSecretMigrations(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an older `owners` or `agents` table unchanged.
 * Add the signing-secret columns before any query reads them.
 */
function applySigningSecretMigrations(db: Database.Database): void {
  for (const step of SIGNING_SECRET_MIGRATIONS) {
    const rows = db.prepare(`PRAGMA table_info(${step.table})`).all() as { name: string }[];
    if (rows.some((row) => row.name === step.column)) continue;
    db.exec(step.sql);
  }
}
