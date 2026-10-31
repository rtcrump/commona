import { rowsOf, type SqlDriver } from "./adapter.js";
import { type SqlValue } from "./sql.js";

interface DurableSqlCursor {
  toArray(): Record<string, unknown>[];
}

/**
 * The storage handle on a SQLite Durable Object.
 * Free-plan Durable Objects expose this SQL API and not the key-value kind.
 */
export interface DurableSqlStorage {
  sql: {
    exec(query: string, ...bindings: DurableBinding[]): DurableSqlCursor;
  };
  transactionSync<T>(callback: () => T): T;
}

type DurableBinding = ArrayBuffer | string | number | null;

/** SQLite inside one Durable Object. Statements stay synchronous, as the room code expects. */
export class DurableSqlDriver implements SqlDriver {
  private depth = 0;

  constructor(private readonly storage: DurableSqlStorage) {}

  execute(sql: string): void {
    this.storage.sql.exec(sql);
  }

  query(sql: string, bindings: readonly SqlValue[]): Record<string, unknown>[] {
    const cursor = this.exec(sql, bindings);
    return rowsOf(cursor.toArray());
  }

  run(sql: string, bindings: readonly SqlValue[]): { changes: number; lastInsertRowid: number } {
    this.exec(sql, bindings);
    const row = this.storage.sql.exec("SELECT changes() AS changes, last_insert_rowid() AS id").toArray()[0];
    return {
      changes: Number(row?.changes ?? 0),
      lastInsertRowid: Number(row?.id ?? 0),
    };
  }

  inTransaction<T>(_mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", fn: () => T): T {
    // Durable Object SQL rejects SAVEPOINT. A nested write stays in the open
    // transactionSync. A throw still rolls the whole transaction back.
    if (this.depth > 0) return fn();
    return this.storage.transactionSync(() => {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    });
  }

  close(): void {
    // The Durable Object keeps the database. Closing the handle is a no-op.
  }

  private exec(sql: string, bindings: readonly SqlValue[]): DurableSqlCursor {
    const bound = bindings.map(toDurableBinding);
    return this.storage.sql.exec(sql, ...bound);
  }
}

function toDurableBinding(value: SqlValue): DurableBinding {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
  }
  return value;
}
