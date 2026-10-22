import type Database from "better-sqlite3";
import { bindSql, plainRow, splitSql, type SqlValue } from "./sql.js";

export interface SqlDriver {
  execute(sql: string): void;
  query(sql: string, bindings: readonly SqlValue[]): Record<string, unknown>[];
  run(sql: string, bindings: readonly SqlValue[]): { changes: number; lastInsertRowid: number };
  inTransaction<T>(mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", fn: () => T): T;
  close(): void;
}

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface Statement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): RunResult;
}

/**
 * The methods the room, audit log, and sign-in code call on better-sqlite3.
 * Callers keep their SQL. This object is the database they already expect.
 */
export function createSqliteDatabase(driver: SqlDriver): Database.Database {
  let open = true;
  const db = {
    prepare(sql: string): Statement {
      return {
        get(...args: unknown[]): unknown {
          const bound = bindSql(sql, args);
          const rows = driver.query(bound.text, bound.bindings);
          return rows[0];
        },
        all(...args: unknown[]): unknown[] {
          const bound = bindSql(sql, args);
          return driver.query(bound.text, bound.bindings);
        },
        run(...args: unknown[]): RunResult {
          const bound = bindSql(sql, args);
          return driver.run(bound.text, bound.bindings);
        },
      };
    },
    exec(sql: string): void {
      for (const statement of splitSql(sql)) driver.execute(statement);
    },
    pragma(source: string): void {
      driver.execute(`PRAGMA ${source}`);
    },
    transaction<T>(fn: (...args: never[]) => T) {
      const call = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE") => {
        return (...args: never[]): T => driver.inTransaction(mode, () => fn(...args));
      };
      const deferred = call("DEFERRED") as ((...args: never[]) => T) & {
        deferred: (...args: never[]) => T;
        immediate: (...args: never[]) => T;
        exclusive: (...args: never[]) => T;
      };
      deferred.deferred = deferred;
      deferred.immediate = call("IMMEDIATE");
      deferred.exclusive = call("EXCLUSIVE");
      return deferred;
    },
    close(): void {
      if (!open) return;
      open = false;
      driver.close();
    },
    get open(): boolean {
      return open;
    },
  };
  return db as unknown as Database.Database;
}

export function rowsOf(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => plainRow(row));
}
