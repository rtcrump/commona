import { DatabaseSync } from "node:sqlite";
import { rowsOf, type SqlDriver } from "./adapter.js";
import type { SqlValue } from "./sql.js";

/** node:sqlite for the Node tests and the acceptance harness. */
export class NodeSqlDriver implements SqlDriver {
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  execute(sql: string): void {
    this.db.exec(sql);
  }

  query(sql: string, bindings: readonly SqlValue[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    const rows = bindings.length === 0 ? stmt.all() : stmt.all(...bindings);
    return rowsOf(rows as Record<string, unknown>[]);
  }

  run(sql: string, bindings: readonly SqlValue[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.db.prepare(sql);
    const result = bindings.length === 0 ? stmt.run() : stmt.run(...bindings);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  inTransaction<T>(mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", fn: () => T): T {
    if (this.depth > 0) return this.savepoint(fn);
    const begin = mode === "DEFERRED" ? "BEGIN DEFERRED" : mode === "EXCLUSIVE" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE";
    this.db.exec(begin);
    this.depth = 1;
    try {
      const result = fn();
      this.depth = 0;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.depth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction is already closed.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private savepoint<T>(fn: () => T): T {
    const name = `commona_sp_${this.depth}`;
    this.depth += 1;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      this.depth -= 1;
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      } catch {
        // The savepoint is already gone.
      }
      this.depth -= 1;
      throw error;
    }
  }
}

export function openNodeDriver(path: string): SqlDriver {
  return new NodeSqlDriver(new DatabaseSync(path));
}
