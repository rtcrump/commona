import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  ReasonCode,
  UNSCOPED_ROOM,
  formatTimestamp,
  ownerActorId,
  type AuditLog,
  type AuthPrincipal,
  type Clock,
} from "../../contract/index.js";
import { CLARITY_PRESET } from "./preset.js";

/**
 * One row per owner. The table is `privacy_filters` in `SCHEMA_SQL`.
 * This module inserts no row when the table is created.
 * A new row blocks nothing: no terms, no built-in patterns, no presets.
 * A missing row is that same empty filter. The caller allows the item.
 * A corrupt row, or a table that cannot be read, is not empty. The caller holds the item.
 * Terms are not copied into the audit log.
 */

export interface PatternFlags {
  healthNumber: boolean;
  dob: boolean;
}

/** Off until the owner turns them on. An empty pattern list is a valid filter. */
export const PATTERNS_OFF: PatternFlags = { healthNumber: false, dob: false };

/** Both built-in patterns. Callers pass this when an owner has switched them on. */
export const PATTERNS_ON: PatternFlags = { healthNumber: true, dob: true };

const ON_PATTERNS_JSON = JSON.stringify(["health_number", "dob"]);

export interface ReadyFilter {
  status: "ready";
  terms: readonly string[];
  patterns: PatternFlags;
  presets: readonly string[];
}

export type LoadedFilter = ReadyFilter | { status: "missing" } | { status: "corrupt" };

export interface FilterEditorDeps {
  db: SqliteDatabase;
  audit: AuditLog;
  clock: Clock;
}

export type FilterChange =
  | { terms: readonly string[] }
  | { patterns: PatternFlags }
  | { preset: typeof CLARITY_PRESET; enabled: boolean };

export type FilterUpdateResult =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode: typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner;
    };

interface FilterRow {
  terms_json: string;
  patterns_json: string;
  presets_json: string;
}

export function readFilter(db: SqliteDatabase, ownerId: string): LoadedFilter {
  const row = db
    .prepare<[string], FilterRow>(
      "SELECT terms_json, patterns_json, presets_json FROM privacy_filters WHERE owner_id = ?",
    )
    .get(ownerId);
  if (!row) return { status: "missing" };
  const terms = parseStringArray(row.terms_json);
  const patterns = parsePatterns(row.patterns_json);
  const presets = parsePresets(row.presets_json);
  if (!terms || !patterns || !presets) return { status: "corrupt" };
  return { status: "ready", terms, patterns, presets };
}

/**
 * Showroom owners only. Turns the Clarity preset on and leaves patterns alone.
 * Patient names live in that preset. This does not switch health-number or
 * date-of-birth patterns on. Does not write an audit row.
 */
export function installClarityDemo(db: SqliteDatabase, ownerId: string): void {
  db.prepare(
    `INSERT INTO privacy_filters (owner_id, terms_json, patterns_json, presets_json)
     VALUES (?, '[]', '[]', ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       presets_json = excluded.presets_json`,
  ).run(ownerId, JSON.stringify([CLARITY_PRESET]));
}

/**
 * Showroom owners only. Turns health-number and date-of-birth patterns on.
 * Milestone 1 P3 still expects those blocks. A new owner does not get this.
 * Does not add patient names and does not write an audit row.
 */
export function enableBuiltinPatterns(db: SqliteDatabase, ownerId: string): void {
  db.prepare(
    `INSERT INTO privacy_filters (owner_id, terms_json, patterns_json, presets_json)
     VALUES (?, '[]', ?, '[]')
     ON CONFLICT(owner_id) DO UPDATE SET
       patterns_json = excluded.patterns_json`,
  ).run(ownerId, ON_PATTERNS_JSON);
}

/**
 * Inserts the default row when the owner does not have one yet.
 * The row blocks nothing. It does not replace a row the owner already has.
 */
export function ensureDefaultFilter(db: SqliteDatabase, ownerId: string): void {
  db.prepare(
    `INSERT INTO privacy_filters (owner_id, terms_json, patterns_json, presets_json)
     VALUES (?, '[]', '[]', '[]')
     ON CONFLICT(owner_id) DO NOTHING`,
  ).run(ownerId);
}

/**
 * Only that owner's owner token may write. An agent is refused even when the
 * owner id matches. The row is unchanged on a refusal. The audit row names the
 * owner and the result, not the terms.
 */
export function updatePrivacyFilter(
  deps: FilterEditorDeps,
  principal: AuthPrincipal,
  ownerId: string,
  change: FilterChange,
): FilterUpdateResult {
  const refusal = refusalFor(principal, ownerId);
  if (refusal) {
    recordFilterAudit(deps, principal, ownerId, false, refusal);
    return { allowed: false, reasonCode: refusal };
  }
  const current = readFilter(deps.db, ownerId);
  const base = current.status === "ready" ? current : emptyReady();
  const next = applyChange(base, change);
  deps.db
    .prepare(
      `INSERT INTO privacy_filters (owner_id, terms_json, patterns_json, presets_json)
       VALUES (@ownerId, @terms, @patterns, @presets)
       ON CONFLICT(owner_id) DO UPDATE SET
         terms_json = excluded.terms_json,
         patterns_json = excluded.patterns_json,
         presets_json = excluded.presets_json`,
    )
    .run({
      ownerId,
      terms: JSON.stringify(next.terms),
      patterns: JSON.stringify(patternsToList(next.patterns)),
      presets: JSON.stringify(next.presets),
    });
  recordFilterAudit(deps, principal, ownerId, true);
  return { allowed: true };
}

function refusalFor(
  principal: AuthPrincipal,
  ownerId: string,
): typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner | undefined {
  const kind: string = principal.kind;
  if (kind === "agent") return ReasonCode.AgentCannotChangeSharing;
  if (kind !== "owner" || principal.ownerId !== ownerId) return ReasonCode.NotOwner;
  return undefined;
}

function recordFilterAudit(
  deps: FilterEditorDeps,
  principal: AuthPrincipal,
  ownerId: string,
  allowed: boolean,
  reasonCode?: typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner,
): void {
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: UNSCOPED_ROOM,
    agentId: principal.kind === "agent" ? principal.agentId : ownerActorId(principal.ownerId),
    ownerId: principal.ownerId,
    action: allowed ? AuditAction.SettingChange : AuditAction.SettingChangeRefused,
    result: allowed ? AuditResult.Ok : AuditResult.Refused,
    detail: {
      fromOwnerId: ownerId,
      ...(reasonCode ? { reasonCode } : {}),
    },
  });
}

function applyChange(base: ReadyFilter, change: FilterChange): ReadyFilter {
  if ("terms" in change) {
    return { ...base, terms: [...change.terms] };
  }
  if ("patterns" in change) {
    return {
      ...base,
      patterns: { healthNumber: change.patterns.healthNumber, dob: change.patterns.dob },
    };
  }
  const presets = new Set(base.presets);
  if (change.enabled) presets.add(CLARITY_PRESET);
  else presets.delete(CLARITY_PRESET);
  return { ...base, presets: [...presets] };
}

/** The row a new owner starts from. Nothing is listed and no pattern is on. */
function emptyReady(): ReadyFilter {
  return {
    status: "ready",
    terms: [],
    patterns: { ...PATTERNS_OFF },
    presets: [],
  };
}

function patternsToList(patterns: PatternFlags): string[] {
  const list: string[] = [];
  if (patterns.healthNumber) list.push("health_number");
  if (patterns.dob) list.push("dob");
  return list;
}

function parseStringArray(json: string): string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function parsePatterns(json: string): PatternFlags | undefined {
  const list = parseStringArray(json);
  if (!list) return undefined;
  if (list.some((item) => item !== "health_number" && item !== "dob")) return undefined;
  return {
    healthNumber: list.includes("health_number"),
    dob: list.includes("dob"),
  };
}

function parsePresets(json: string): string[] | undefined {
  const list = parseStringArray(json);
  if (!list) return undefined;
  if (list.some((item) => item !== CLARITY_PRESET)) return undefined;
  return list;
}
