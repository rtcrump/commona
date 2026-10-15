import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  ContractError,
  ReasonCode,
  UNSCOPED_ROOM,
  formatTimestamp,
  ownerActorId,
  type AuditLog,
  type AuthPrincipal,
  type Clock,
  type ContentGuard,
  type GuardDecision,
  type GuardTarget,
} from "../../contract/index.js";
import { CLARITY_PRESET_ID, loadPresetTerms } from "./preset.js";
import { scanContent, type ScanPatterns } from "./scan.js";

/**
 * Per-owner privacy filter.
 *
 * A new owner row stores the built-in patterns on and an empty term list.
 * Patient names are not in that default. They live in the Clarity demo preset,
 * which an owner turns on. A missing row, or JSON that is not this shape,
 * holds the item. Nothing here turns a pattern off unless the owner set false.
 * The module writes the audit row for a filter edit. There is no HTTP route
 * yet. See contract-proposals/001-privacy-filter.md.
 */

const CONFIG_KEYS = ["terms", "patterns", "presets"] as const;
const PATTERN_KEYS = ["health_number", "dob"] as const;

export interface PrivacyConfig {
  terms: readonly string[];
  patterns: ScanPatterns;
  presets: readonly string[];
}

export interface PrivacyPatch {
  terms?: readonly string[];
  patterns?: { healthNumber?: boolean; dob?: boolean };
  presets?: readonly string[];
}

export type PrivacyUpdateResult =
  | { allowed: true; config: PrivacyConfig }
  | {
      allowed: false;
      reasonCode: typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner;
    };

interface StoredRow {
  config_json: string;
}

export function defaultPrivacyConfig(): PrivacyConfig {
  return {
    terms: [],
    patterns: { healthNumber: true, dob: true },
    presets: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameOwnerId(left: string, right: string): boolean {
  return left.normalize("NFKC") === right.normalize("NFKC");
}

/** Missing pattern keys stay on. A non-boolean is unreadable. */
function readFlag(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const value = record[key];
  if (typeof value !== "boolean") throw new Error("unreadable pattern flag");
  return value;
}

export function parsePrivacyConfig(json: string): PrivacyConfig {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("unreadable config");
  for (const key of Object.keys(value)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new Error("unreadable config");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "terms") || !Array.isArray(value.terms)) {
    throw new Error("unreadable config");
  }
  if (value.terms.some((term) => typeof term !== "string")) throw new Error("unreadable config");
  if (!Object.prototype.hasOwnProperty.call(value, "presets") || !Array.isArray(value.presets)) {
    throw new Error("unreadable config");
  }
  if (value.presets.some((preset) => typeof preset !== "string")) throw new Error("unreadable config");
  for (const preset of value.presets) {
    if (preset !== CLARITY_PRESET_ID) throw new Error("unreadable config");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "patterns") || !isRecord(value.patterns)) {
    throw new Error("unreadable config");
  }
  for (const key of Object.keys(value.patterns)) {
    if (!(PATTERN_KEYS as readonly string[]).includes(key)) throw new Error("unreadable config");
  }
  const defaults = defaultPrivacyConfig().patterns;
  return {
    terms: value.terms,
    presets: value.presets,
    patterns: {
      healthNumber: readFlag(value.patterns, "health_number", defaults.healthNumber),
      dob: readFlag(value.patterns, "dob", defaults.dob),
    },
  };
}

function serialize(config: PrivacyConfig): string {
  return JSON.stringify({
    terms: [...config.terms],
    patterns: {
      health_number: config.patterns.healthNumber,
      dob: config.patterns.dob,
    },
    presets: [...config.presets],
  });
}

function readRow(db: SqliteDatabase, ownerId: string): StoredRow | undefined {
  return db
    .prepare<[string], StoredRow>("SELECT config_json FROM privacy_filters WHERE owner_id = ?")
    .get(ownerId);
}

export type LoadedPrivacyConfig = { status: "ok"; config: PrivacyConfig } | { status: "missing" } | { status: "corrupt" };

export function loadPrivacyConfig(db: SqliteDatabase, ownerId: string): LoadedPrivacyConfig {
  const row = readRow(db, ownerId);
  if (!row) return { status: "missing" };
  try {
    return { status: "ok", config: parsePrivacyConfig(row.config_json) };
  } catch {
    return { status: "corrupt" };
  }
}

function termsFor(config: PrivacyConfig): readonly string[] | undefined {
  const terms = [...config.terms];
  for (const preset of config.presets) {
    const loaded = loadPresetTerms(preset);
    if (!loaded) return undefined;
    terms.push(...loaded);
  }
  return terms;
}

/** Hold when the row is missing, unreadable, or a named preset cannot be loaded. */
export function decideForOwner(db: SqliteDatabase, ownerId: string, target: GuardTarget): GuardDecision {
  if (ownerId.normalize("NFKC") === "") return { outcome: "block", hits: [] };
  const loaded = loadPrivacyConfig(db, ownerId);
  if (loaded.status !== "ok") return { outcome: "block", hits: [] };
  const terms = termsFor(loaded.config);
  if (!terms) return { outcome: "block", hits: [] };
  const hits = scanContent(target, terms, loaded.config.patterns);
  return { outcome: hits.length === 0 ? "allow" : "block", hits };
}

function readOwnerId(target: GuardTarget): string {
  if (!("ownerId" in target)) return "";
  const value = (target as { ownerId?: unknown }).ownerId;
  return typeof value === "string" ? value : "";
}

/**
 * Content guard for the live server. The owner id rides on the target object
 * because the contract target has no owner field. No owner id holds the item.
 */
export function createPrivacyGuard(db: SqliteDatabase): ContentGuard {
  return {
    check(target: GuardTarget): GuardDecision {
      return decideForOwner(db, readOwnerId(target), target);
    },
  };
}

function writeConfig(db: SqliteDatabase, ownerId: string, config: PrivacyConfig, updatedAt: string): void {
  db.prepare(
    `INSERT INTO privacy_filters (owner_id, config_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`,
  ).run(ownerId, serialize(config), updatedAt);
}

/**
 * Default row for a new owner: patterns on, no terms, no preset.
 * Does not overwrite a row that is already there, including a corrupt one.
 * Does not write the audit log. Seeding is not an owner edit.
 */
export function ensureDefaultPrivacyFilter(db: SqliteDatabase, ownerId: string, updatedAt: string): void {
  const existing = readRow(db, ownerId);
  if (existing) return;
  writeConfig(db, ownerId, defaultPrivacyConfig(), updatedAt);
}

/**
 * Fixture owners opt into the Clarity demo so the M1 name cases still block.
 * Any other new owner stays on the empty term list.
 */
export function seedFixturePrivacyFilters(
  db: SqliteDatabase,
  ownerIds: readonly string[],
  updatedAt = "2026-01-01T00:00:00.000Z",
): void {
  const config: PrivacyConfig = {
    ...defaultPrivacyConfig(),
    presets: [CLARITY_PRESET_ID],
  };
  for (const ownerId of ownerIds) writeConfig(db, ownerId, config, updatedAt);
}

function assertPatch(patch: PrivacyPatch): void {
  if (patch.terms !== undefined && patch.terms.some((term) => typeof term !== "string")) {
    throw new ContractError("privacy filter terms must be strings");
  }
  if (patch.presets !== undefined && patch.presets.some((preset) => preset !== CLARITY_PRESET_ID)) {
    throw new ContractError("unknown privacy filter preset");
  }
  const patterns = patch.patterns;
  if (!patterns) return;
  if (patterns.healthNumber !== undefined && typeof patterns.healthNumber !== "boolean") {
    throw new ContractError("privacy filter pattern flag must be boolean");
  }
  if (patterns.dob !== undefined && typeof patterns.dob !== "boolean") {
    throw new ContractError("privacy filter pattern flag must be boolean");
  }
}

function applyPatch(base: PrivacyConfig, patch: PrivacyPatch): PrivacyConfig {
  return {
    terms: patch.terms !== undefined ? [...patch.terms] : [...base.terms],
    presets: patch.presets !== undefined ? [...patch.presets] : [...base.presets],
    patterns: {
      healthNumber: patch.patterns?.healthNumber ?? base.patterns.healthNumber,
      dob: patch.patterns?.dob ?? base.patterns.dob,
    },
  };
}

function actorId(principal: AuthPrincipal): string {
  return principal.kind === "agent" ? principal.agentId : ownerActorId(principal.ownerId);
}

export interface PrivacyFilter {
  check(ownerId: string, target: GuardTarget): GuardDecision;
  update(principal: AuthPrincipal, ownerId: string, patch: PrivacyPatch): PrivacyUpdateResult;
  ensureDefault(ownerId: string): void;
}

export function createPrivacyFilter(db: SqliteDatabase, audit: AuditLog, clock: Clock): PrivacyFilter {
  function auditEdit(
    principal: AuthPrincipal,
    ownerId: string,
    allowed: boolean,
    reasonCode?: typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner,
  ): void {
    audit.append({
      ts: formatTimestamp(clock.now()),
      room: UNSCOPED_ROOM,
      agentId: actorId(principal),
      ownerId: principal.ownerId,
      action: allowed ? AuditAction.SettingChange : AuditAction.SettingChangeRefused,
      result: allowed ? AuditResult.Ok : AuditResult.Refused,
      detail: {
        fromOwnerId: ownerId,
        targetOwnerId: ownerId,
        ...(reasonCode ? { reasonCode } : {}),
      },
    });
  }

  return {
    check(ownerId: string, target: GuardTarget): GuardDecision {
      return decideForOwner(db, ownerId, target);
    },
    ensureDefault(ownerId: string): void {
      ensureDefaultPrivacyFilter(db, ownerId, formatTimestamp(clock.now()));
    },
    update(principal: AuthPrincipal, ownerId: string, patch: PrivacyPatch): PrivacyUpdateResult {
      assertPatch(patch);
      if (principal.kind === "agent") {
        auditEdit(principal, ownerId, false, ReasonCode.AgentCannotChangeSharing);
        return { allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing };
      }
      if (principal.kind !== "owner" || !sameOwnerId(principal.ownerId, ownerId)) {
        auditEdit(principal, ownerId, false, ReasonCode.NotOwner);
        return { allowed: false, reasonCode: ReasonCode.NotOwner };
      }
      const loaded = loadPrivacyConfig(db, ownerId);
      const base = loaded.status === "ok" ? loaded.config : defaultPrivacyConfig();
      const config = applyPatch(base, patch);
      writeConfig(db, ownerId, config, formatTimestamp(clock.now()));
      auditEdit(principal, ownerId, true);
      return { allowed: true, config };
    },
  };
}
