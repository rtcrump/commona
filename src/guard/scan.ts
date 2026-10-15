import {
  BlockCategory,
  BlockLocation,
  DOB_CUE_WINDOW_CHARS,
  DOB_MONTH_NAMES,
  HEALTH_NUMBER_PATTERN,
  type GuardHit,
  type GuardTarget,
} from "../../contract/index.js";
import { normalizeForNameMatch, phraseKey, scanVariants } from "./normalize.js";

/**
 * Built-in pattern types. A missing flag means on. Only an explicit false
 * turns one off. The caller decides that. This scanner just honours the flags.
 */
export interface ScanPatterns {
  healthNumber: boolean;
  dob: boolean;
}

const MONTH_NAMES_LONGEST_FIRST = [...DOB_MONTH_NAMES].sort((a, b) => b.length - a.length);
const MONTH_DATE = `\\b(?:${MONTH_NAMES_LONGEST_FIRST.join("|")})\\s+\\d{1,2},\\s*\\d{4}\\b`;
const DATE_SOURCES = [String.raw`\b\d{4}-\d{2}-\d{2}\b`, String.raw`\b\d{1,2}/\d{1,2}/\d{4}\b`, MONTH_DATE];
const CUE_SOURCES = [String.raw`\bdate of birth\b`, String.raw`d\.o\.b\.`, String.raw`\bdob\b`, String.raw`\bborn\b`];
const HEALTH_NUMBER = new RegExp(HEALTH_NUMBER_PATTERN);

interface Span {
  start: number;
  end: number;
}

function containsPhrase(folded: string, phrases: readonly string[]): boolean {
  const normalized = phraseKey(folded);
  return phrases.some((phrase) => phrase.length > 0 && normalized.includes(phrase));
}

function containsHealthNumber(folded: string): boolean {
  return HEALTH_NUMBER.test(folded);
}

function spans(value: string, source: string): Span[] {
  const found: Span[] = [];
  for (const match of value.matchAll(new RegExp(source, "gi"))) {
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length });
  }
  return found;
}

function charactersBetween(left: Span, right: Span): number {
  if (left.end <= right.start) return right.start - left.end;
  if (right.end <= left.start) return left.start - right.end;
  return 0;
}

/** A date counts only on the same line as a cue, within the character window. */
function containsDob(folded: string): boolean {
  for (const line of folded.split(/\r\n|\n|\r/)) {
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
  patterns: ScanPatterns,
): void {
  const variants = scanVariants(value);
  if (phrases.length > 0 && variants.some((folded) => containsPhrase(folded, phrases))) {
    pushHit(hits, { category: BlockCategory.Name, location });
  }
  if (patterns.healthNumber && variants.some((folded) => containsHealthNumber(folded))) {
    pushHit(hits, { category: BlockCategory.HealthNumber, location });
  }
  if (patterns.dob && variants.some((folded) => containsDob(folded))) {
    pushHit(hits, { category: BlockCategory.Dob, location });
  }
}

/**
 * Scan order is file name, then metadata keys sorted, then text or file body.
 * Inside one field the order is term, health number, date of birth.
 * `hits[0]` is the audit hit. It never carries the matched text.
 */
export function scanContent(target: GuardTarget, terms: readonly string[], patterns: ScanPatterns): GuardHit[] {
  const phrases = terms.map((term) => normalizeForNameMatch(term)).filter((term) => term.length > 0);
  const hits: GuardHit[] = [];
  if (target.fileName !== undefined) scanField(hits, target.fileName, BlockLocation.FileName, phrases, patterns);
  if (target.metadata) {
    for (const key of Object.keys(target.metadata).sort()) {
      scanField(hits, key, BlockLocation.FileMeta, phrases, patterns);
      const metaValue = target.metadata[key];
      if (metaValue !== undefined) scanField(hits, metaValue, BlockLocation.FileMeta, phrases, patterns);
    }
  }
  if (target.text !== undefined) {
    const location = target.kind === "file" ? BlockLocation.FileBody : BlockLocation.Text;
    scanField(hits, target.text, location, phrases, patterns);
  }
  return hits;
}
