import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const applied = new WeakSet<Database.Database>();

/** Apply the invite migration. Safe to call more than once on the same database. */
export function ensureInviteSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  const sqlPath = fileURLToPath(new URL("./migrations/001_invites.sql", import.meta.url));
  db.exec(readFileSync(sqlPath, "utf8"));
  applied.add(db);
}
