import {
  BlockCategory,
  BlockLocation,
  DOB_CUE_WINDOW_CHARS,
  DOB_MONTH_NAMES,
  HEALTH_NUMBER_PATTERN,
  TEXT_MEDIA_TYPE_PREFIX,
  TEXT_MEDIA_TYPES,
  type ContentGuard,
  type GuardDecision,
  type GuardHit,
  type GuardTarget,
} from "../../contract/index.js";

/**
 * Patient-name block. Always on: there is no switch.
 *
 * `hits[0]` is the audit hit. It carries a category and a location, never the
 * matched text. Scan order is file name, then metadata keys sorted, then the
 * message text or file body. Inside one string the order is name,
 * health_number, dob.
 *
 * A `block` outcome is held, kept out of every feed, and sends no wake.
 * This function does not write the log or the notice. The caller does, from
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

/** NFKC, lowercase, `_` `-` `.` to spaces, then collapse whitespace. */
export function normalizeForNameMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(NAME_SEPARATORS, " ").replace(/\s+/g, " ").trim();
}

function containsPhrase(value: string, phrases: readonly string[]): boolean {
  const normalized = normalizeForNameMatch(value);
  return phrases.some((phrase) => phrase.length > 0 && normalized.includes(phrase));
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

function scanField(hits: GuardHit[], value: string, location: GuardHit["location"], phrases: readonly string[]): void {
  if (containsPhrase(value, phrases)) pushHit(hits, { category: BlockCategory.Name, location });
  if (containsHealthNumber(value)) pushHit(hits, { category: BlockCategory.HealthNumber, location });
  if (containsDob(value)) pushHit(hits, { category: BlockCategory.Dob, location });
}

function scan(target: GuardTarget, phrases: readonly string[]): GuardHit[] {
  const hits: GuardHit[] = [];
  if (target.fileName !== undefined) scanField(hits, target.fileName, BlockLocation.FileName, phrases);
  if (target.metadata) {
    for (const key of Object.keys(target.metadata).sort()) {
      scanField(hits, key, BlockLocation.FileMeta, phrases);
      const value = target.metadata[key];
      if (value !== undefined) scanField(hits, value, BlockLocation.FileMeta, phrases);
    }
  }
  if (target.text !== undefined) {
    const location = target.kind === "file" ? BlockLocation.FileBody : BlockLocation.Text;
    scanField(hits, target.text, location, phrases);
  }
  return hits;
}

/** Names are injected. The default list is `fixtures/names.txt`. */
export function createContentGuard(names: readonly string[]): ContentGuard {
  const phrases = names.map((name) => normalizeForNameMatch(name)).filter((name) => name.length > 0);
  return {
    check(target: GuardTarget): GuardDecision {
      const hits = scan(target, phrases);
      return { outcome: hits.length === 0 ? "allow" : "block", hits };
    },
  };
}

let installedGuard: ContentGuard | undefined;

/** Names from a Worker text module. Node reads fixtures/names.txt on first use. */
export function installNameList(text: string): void {
  installedGuard = createContentGuard(parseNameList(text));
}

export function parseNameList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function readDefaultNames(): readonly string[] {
  const fs = builtinFs();
  const url = builtinUrl();
  if (!fs || !url) throw new Error("name list is not installed");
  const file = url.fileURLToPath(new URL("../../fixtures/names.txt", import.meta.url));
  return parseNameList(fs.readFileSync(file, "utf8"));
}

function builtinFs(): { readFileSync(path: string, encoding: "utf8"): string } | undefined {
  const loaded = loadBuiltin("node:fs");
  if (!loaded || typeof loaded !== "object" || !("readFileSync" in loaded)) return undefined;
  return loaded as { readFileSync(path: string, encoding: "utf8"): string };
}

function builtinUrl(): { fileURLToPath(url: URL): string } | undefined {
  const loaded = loadBuiltin("node:url");
  if (!loaded || typeof loaded !== "object" || !("fileURLToPath" in loaded)) return undefined;
  return loaded as { fileURLToPath(url: URL): string };
}

function loadBuiltin(name: string): unknown {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return proc?.getBuiltinModule?.(name);
}

function activeGuard(): ContentGuard {
  if (!installedGuard) installedGuard = createContentGuard(readDefaultNames());
  return installedGuard;
}

export const guard: ContentGuard = {
  check(target: GuardTarget): GuardDecision {
    return activeGuard().check(target);
  },
};

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
