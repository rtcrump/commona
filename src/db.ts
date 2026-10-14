import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../contract/index.js";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
