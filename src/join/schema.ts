import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const applied = new WeakSet<Database.Database>();

/** Apply the invite migration. Safe to call more than once on the same database. */
export function ensureInviteSchema(db: Database.Database): void {
  if (applied.has(db)) return;
  for (const name of ["001_invites.sql", "002_connect.sql", "003_invite_owner.sql"]) {
    const sqlPath = fileURLToPath(new URL(`./migrations/${name}`, import.meta.url));
    db.exec(readFileSync(sqlPath, "utf8"));
  }
  ensureConnectBindingColumn(db);
  applied.add(db);
}

/** Older databases created the connect table before a link could stay bound. */
function ensureConnectBindingColumn(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(connect_links)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "bound_at")) {
    db.exec("ALTER TABLE connect_links ADD COLUMN bound_at TEXT");
  }
}
