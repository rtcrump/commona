/**
 * Split a script into statements SQLite can run one at a time.
 * Durable Object SQL accepts one statement per call. Trigger bodies contain
 * semicolons, so a split on every semicolon would break them.
 */
export function splitSql(sql: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += chunk;
      i += chunk.length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (isWordStart(sql, i)) {
      const word = readWord(sql, i);
      const upper = word.toUpperCase();
      if (upper === "BEGIN") depth += 1;
      else if (upper === "END" && depth > 0) depth -= 1;
      current += word;
      i += word.length;
      continue;
    }
    if (ch === ";" && depth === 0) {
      const statement = current.trim();
      if (statement.length > 0) parts.push(statement);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function isWordStart(sql: string, index: number): boolean {
  const ch = sql[index] ?? "";
  if (!/[A-Za-z_]/.test(ch)) return false;
  if (index === 0) return true;
  return !/[A-Za-z0-9_]/.test(sql[index - 1] ?? "");
}

function readWord(sql: string, index: number): string {
  let j = index + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] ?? "")) j += 1;
  return sql.slice(index, j);
}

export type SqlValue = string | number | null | Uint8Array;

/** `@name`, `:name`, and `$name` become `?` in left-to-right order. */
export function bindSql(sql: string, args: readonly unknown[]): { text: string; bindings: SqlValue[] } {
  if (args.length === 1 && isPlainObject(args[0]) && hasNamedParameter(sql)) {
    return bindNamed(sql, args[0]);
  }
  return { text: sql, bindings: args.map(normalizeValue) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasNamedParameter(sql: string): boolean {
  return scanPlaceholders(sql).some((name) => name.length > 0);
}

function bindNamed(sql: string, params: Record<string, unknown>): { text: string; bindings: SqlValue[] } {
  let text = "";
  const bindings: SqlValue[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      text += chunk;
      i += chunk.length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      text += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "@" || ch === ":" || ch === "$") {
      const word = readWord(sql, i + 1);
      if (word.length > 0) {
        if (!Object.prototype.hasOwnProperty.call(params, word)) {
          throw new Error(`missing SQL parameter ${word}`);
        }
        bindings.push(normalizeValue(params[word]));
        text += "?";
        i += 1 + word.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  return { text, bindings };
}

function scanPlaceholders(sql: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    if (ch === "'" || (ch === "-" && sql[i + 1] === "-")) {
      i += 1;
      continue;
    }
    if (ch === "@" || ch === ":" || ch === "$") {
      const word = readWord(sql, i + 1);
      if (word.length > 0) names.push(word);
    }
    i += 1;
  }
  return names;
}

export function normalizeValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  throw new Error("unsupported SQL binding");
}

export function normalizeCell(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

export function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = normalizeCell(row[key]);
  return out;
}
