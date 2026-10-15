import {
  BlockCategory,
  BlockLocation,
  DOB_CUE_WINDOW_CHARS,
  DOB_MONTH_NAMES,
  HEALTH_NUMBER_PATTERN,
  TEXT_MEDIA_TYPE_PREFIX,
  TEXT_MEDIA_TYPES,
  type BlockLocation as BlockLocationName,
  type ContentGuard,
  type GuardDecision,
  type GuardHit,
  type GuardTarget,
} from "../../contract/index.js";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { PATTERNS_OFF, readFilter, type PatternFlags, type ReadyFilter } from "./filter-store.js";
import { expansionTexts, prepareForScan } from "./normalize.js";
import { CLARITY_PRESET, loadClarityNames } from "./preset.js";

export { PATTERNS_OFF, PATTERNS_ON } from "./filter-store.js";

/**
 * Privacy filter.
 *
 * Commona blocks nothing until the owner sets it. A phrase is blocked only
 * when that owner stores it. Health-number and date-of-birth patterns are
 * switches. They start off. Patient names are not built in. They are added
 * only when that owner turns on the Clarity demo preset.
 *
 * A missing row is an empty filter, so the item is allowed. A corrupt row,
 * or a read that throws, holds the item. Those are not an empty filter.
 * `check` has no owner, so it holds the item. The server calls `checkForOwner`.
 *
 * `hits[0]` is the audit hit. It carries a category and a location, never the
 * matched text. Scan order is file name, then metadata keys sorted, then the
 * message text or file body. Inside one string the order is name,
 * health_number, dob.
 *
 * A `block` outcome is held, kept out of every feed, and sends no wake.
 * This module does not write the log or the notice. The caller does, from
 * `hits[0]` only.
 */

const NAME_SEPARATORS = /[_\-.]/g;

const MONTH_NAMES_LONGEST_FIRST = [...DOB_MONTH_NAMES].sort((a, b) => b.length - a.length);
const MONTH_DATE = `\\b(?:${MONTH_NAMES_LONGEST_FIRST.join("|")})\\s+\\d{1,2},\\s*\\d{4}\\b`;
const DATE_SOURCES = [String.raw`\b\d{4}-\d{2}-\d{2}\b`, String.raw`\b\d{1,2}/\d{1,2}/\d{4}\b`, MONTH_DATE];
const CUE_SOURCES = [String.raw`\bdate of birth\b`, String.raw`d\.o\.b\.`, String.raw`\bdob\b`, String.raw`\bborn\b`];

interface Span {
  start: number;
  end: number;
}

export interface OwnerScopedGuard extends ContentGuard {
  checkForOwner(ownerId: string, target: GuardTarget): GuardDecision;
}

/** NFKC, lowercase, `_` `-` `.` to spaces, then collapse whitespace. */
export function normalizeForNameMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(NAME_SEPARATORS, " ").replace(/\s+/g, " ").trim();
}

export function isOwnerScopedGuard(value: ContentGuard): value is OwnerScopedGuard {
  return typeof (value as OwnerScopedGuard).checkForOwner === "function";
}

/** Uses the owner filter when the guard has one. An injected guard keeps `check`. */
export function screenContent(guard: ContentGuard, ownerId: string, target: GuardTarget): GuardDecision {
  if (isOwnerScopedGuard(guard)) return guard.checkForOwner(ownerId, target);
  return guard.check(target);
}

/**
 * Injected terms only. Built-in patterns stay off unless the caller passes them.
 * This is not the new-owner default and not the server guard.
 * The server uses `createPrivacyGuard`.
 */
export function createContentGuard(
  names: readonly string[],
  patterns: PatternFlags = PATTERNS_OFF,
): ContentGuard {
  const phrases = phraseList(names);
  return {
    check(target: GuardTarget): GuardDecision {
      return decide(target, phrases, patterns);
    },
  };
}

/**
 * The server's guard. `check` has no owner, so it holds the item.
 * `checkForOwner` reads that owner's row. A missing row blocks nothing.
 */
export function createPrivacyGuard(db: SqliteDatabase): OwnerScopedGuard {
  return {
    check(target: GuardTarget): GuardDecision {
      return hold(target);
    },
    checkForOwner(ownerId: string, target: GuardTarget): GuardDecision {
      try {
        const loaded = readFilter(db, ownerId);
        // Missing is empty. This owner has set nothing, so nothing is blocked.
        if (loaded.status === "missing") return decide(target, [], PATTERNS_OFF);
        // Corrupt is not empty. The row cannot be trusted, so the item is held.
        if (loaded.status !== "ready") return hold(target);
        return decide(target, phrasesFor(loaded), loaded.patterns);
      } catch {
        // A throw means the row could not be read. That is not an empty filter.
        return hold(target);
      }
    },
  };
}

/**
 * No terms and no patterns. Not used by the server.
 * Unit tests that need a name list call `createContentGuard`.
 */
export const guard: ContentGuard = createContentGuard([]);

/**
 * True when the declared media type is text or JSON.
 * A body that decodes as UTF-8 is scanned even when this is false.
 */
export function fileBodyIsScanned(mediaType: string): boolean {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith(TEXT_MEDIA_TYPE_PREFIX)) return true;
  return (TEXT_MEDIA_TYPES as readonly string[]).includes(type);
}

/** The file body when it is valid UTF-8. The declared media type is not consulted. */
export function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Phrases that owner stored, and nothing else.
 * Clarity names are added only when that owner's row has the preset on.
 * An empty term list and no preset blocks no phrase.
 */
function phrasesFor(filter: ReadyFilter): string[] {
  const terms = [...filter.terms];
  if (filter.presets.includes(CLARITY_PRESET)) terms.push(...loadClarityNames());
  return phraseList(terms);
}

function phraseList(terms: readonly string[]): string[] {
  return terms
    .map((term) => normalizeForNameMatch(prepareForScan(term)))
    .filter((term) => term.length > 0);
}

function decide(target: GuardTarget, phrases: readonly string[], patterns: PatternFlags): GuardDecision {
  const hits = scan(target, phrases, patterns);
  return { outcome: hits.length === 0 ? "allow" : "block", hits };
}

/**
 * Used when the filter cannot be trusted: corrupt JSON, a read that throws,
 * or `check` with no owner. A missing row does not come here.
 * The audit schema has no separate category for a bad filter.
 * The hold is stored as a name hit so the owner is told. The text is not stored.
 */
function hold(target: GuardTarget): GuardDecision {
  return {
    outcome: "block",
    hits: [{ category: BlockCategory.Name, location: holdLocation(target) }],
  };
}

function holdLocation(target: GuardTarget): BlockLocationName {
  if (target.fileName !== undefined) return BlockLocation.FileName;
  if (target.metadata && Object.keys(target.metadata).length > 0) return BlockLocation.FileMeta;
  return target.kind === "file" ? BlockLocation.FileBody : BlockLocation.Text;
}

function formsOf(value: string): string[] {
  return expansionTexts(value).map((text) => prepareForScan(text));
}

function containsPhrase(forms: readonly string[], phrases: readonly string[]): boolean {
  return forms.some((form) => {
    const normalized = normalizeForNameMatch(form);
    return phrases.some((phrase) => phrase.length > 0 && normalized.includes(phrase));
  });
}

function containsHealthNumber(value: string): boolean {
  return new RegExp(HEALTH_NUMBER_PATTERN).test(value);
}

function spans(value: string, source: string): Span[] {
  const found: Span[] = [];
  for (const match of value.matchAll(new RegExp(source, "gi"))) {
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length });
  }
  return found;
}

/** Characters strictly between the two spans. Zero when they overlap. */
function charactersBetween(left: Span, right: Span): number {
  if (left.end <= right.start) return right.start - left.end;
  if (right.end <= left.start) return left.start - right.end;
  return 0;
}

/**
 * A date counts only on the same line as a cue, and only when the gap between
 * them is at most DOB_CUE_WINDOW_CHARS. Shapes: YYYY-MM-DD, D/M/YYYY, Month D, YYYY.
 */
function containsDob(value: string): boolean {
  for (const line of value.split(/\r\n|\n|\r/)) {
    const cues = CUE_SOURCES.flatMap((source) => spans(line, source));
    if (cues.length === 0) continue;
    const dates = DATE_SOURCES.flatMap((source) => spans(line, source));
    for (const date of dates) {
      for (const cue of cues) {
        if (charactersBetween(cue, date) <= DOB_CUE_WINDOW_CHARS) return true;
      }
    }
  }
  return false;
}

function pushHit(hits: GuardHit[], hit: GuardHit): void {
  const seen = hits.some((existing) => existing.category === hit.category && existing.location === hit.location);
  if (!seen) hits.push(hit);
}

function scanField(
  hits: GuardHit[],
  value: string,
  location: GuardHit["location"],
  phrases: readonly string[],
  patterns: PatternFlags,
): void {
  const forms = formsOf(value);
  if (containsPhrase(forms, phrases)) pushHit(hits, { category: BlockCategory.Name, location });
  if (patterns.healthNumber && forms.some((form) => containsHealthNumber(form))) {
    pushHit(hits, { category: BlockCategory.HealthNumber, location });
  }
  if (patterns.dob && forms.some((form) => containsDob(form))) {
    pushHit(hits, { category: BlockCategory.Dob, location });
  }
}

function scan(target: GuardTarget, phrases: readonly string[], patterns: PatternFlags): GuardHit[] {
  const hits: GuardHit[] = [];
  if (target.fileName !== undefined) scanField(hits, target.fileName, BlockLocation.FileName, phrases, patterns);
  if (target.metadata) {
    for (const key of Object.keys(target.metadata).sort()) {
      scanField(hits, key, BlockLocation.FileMeta, phrases, patterns);
      const value = target.metadata[key];
      if (value !== undefined) scanField(hits, value, BlockLocation.FileMeta, phrases, patterns);
    }
  }
  if (target.text !== undefined) {
    const location = target.kind === "file" ? BlockLocation.FileBody : BlockLocation.Text;
    scanField(hits, target.text, location, phrases, patterns);
  }
  return hits;
}
