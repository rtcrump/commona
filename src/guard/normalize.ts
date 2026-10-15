/**
 * Text the privacy filter matches on.
 *
 * Line separators (U+2028, U+2029) become newlines. They are not format
 * characters and are not deleted. Format characters (Unicode Cf) are removed
 * after NFKC. Greek and Cyrillic look-alikes fold to Latin. Decoding stops
 * at {@link MAX_DECODE_DEPTH}. A third wrap is a known limit.
 */

/** Base64, URL encoding, and HTML entities. A fourth encoding step is not applied. */
export const MAX_DECODE_DEPTH = 2;

const LINE_SEPARATORS = /[\u2028\u2029]/g;
const FORMAT_CHARS = /\p{Cf}/gu;
const NAME_SEPARATORS = /[_\-.]/g;

/**
 * Letters that look like Latin. Capitals and small letters are both listed.
 * This is not a full confusable table. It covers the Greek and Cyrillic
 * letters people use to stand in for a Latin letter.
 */
const CONFUSABLE_FOLDS: Record<string, string> = {
  "\u0391": "A",
  "\u03B1": "a",
  "\u0392": "B",
  "\u0395": "E",
  "\u03B5": "e",
  "\u0396": "Z",
  "\u0397": "H",
  "\u0399": "I",
  "\u03B9": "i",
  "\u039A": "K",
  "\u03BA": "k",
  "\u039C": "M",
  "\u03BC": "m",
  "\u039D": "N",
  "\u039F": "O",
  "\u03BF": "o",
  "\u03A1": "P",
  "\u03C1": "p",
  "\u03A4": "T",
  "\u03C4": "t",
  "\u03A5": "Y",
  "\u03C5": "y",
  "\u03A7": "X",
  "\u03C7": "x",
  "\u0410": "A",
  "\u0430": "a",
  "\u0412": "B",
  "\u0415": "E",
  "\u0435": "e",
  "\u0401": "E",
  "\u0451": "e",
  "\u041A": "K",
  "\u043A": "k",
  "\u041C": "M",
  "\u043C": "m",
  "\u041D": "H",
  "\u043D": "h",
  "\u041E": "O",
  "\u043E": "o",
  "\u0420": "P",
  "\u0440": "p",
  "\u0421": "C",
  "\u0441": "c",
  "\u0422": "T",
  "\u0442": "t",
  "\u0423": "Y",
  "\u0443": "y",
  "\u0425": "X",
  "\u0445": "x",
  "\u0406": "I",
  "\u0456": "i",
  "\u0408": "J",
  "\u0458": "j",
  "\u0405": "S",
  "\u0455": "s",
};

const CONFUSABLE_PATTERN = new RegExp(`[${Object.keys(CONFUSABLE_FOLDS).join("")}]`, "gu");

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

const HAS_HTML_ENTITY = /&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/;
const HTML_ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g;
const HAS_PERCENT = /%[0-9A-Fa-f]{2}/;
const BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Minimum token length. Shorter tokens are ordinary words often enough to false-block. */
const MIN_BASE64_CHARS = 16;

function foldConfusables(value: string): string {
  return value.replace(CONFUSABLE_PATTERN, (char) => CONFUSABLE_FOLDS[char] ?? char);
}

/**
 * NFKC, drop Cf, fold look-alikes. U+2028 and U+2029 are newlines first,
 * so a date on the next line stays on the next line.
 */
export function foldForMatch(value: string): string {
  const lined = value.replace(LINE_SEPARATORS, "\n");
  const compatible = lined.normalize("NFKC");
  const stripped = compatible.replace(FORMAT_CHARS, "");
  return foldConfusables(stripped);
}

/** Phrase form: folded, lower case, `_` `-` `.` to spaces, whitespace collapsed. */
export function normalizeForNameMatch(value: string): string {
  return collapsePhrase(foldForMatch(value));
}

function collapsePhrase(value: string): string {
  return value.toLowerCase().replace(NAME_SEPARATORS, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string | undefined {
  if (!HAS_HTML_ENTITY.test(value)) return undefined;
  const decoded = value.replace(HTML_ENTITY, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return codePoint(code) ?? whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return codePoint(code) ?? whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
  return decoded === value ? undefined : decoded;
}

function codePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}

function decodeUrl(value: string): string | undefined {
  if (!HAS_PERCENT.test(value)) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? undefined : decoded;
  } catch {
    let changed = false;
    const decoded = value.replace(/%[0-9A-Fa-f]{2}/g, (sequence) => {
      try {
        changed = true;
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
    return changed && decoded !== value ? decoded : undefined;
  }
}

/** Tab, LF, and CR stay. Other C0 controls are not useful base64 text. */
function hasDisallowedControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) return true;
  }
  return false;
}

function looksLikeEncodedBase64(token: string): boolean {
  if (token.length < MIN_BASE64_CHARS || token.length % 4 !== 0) return false;
  if (!BASE64_TOKEN.test(token)) return false;
  // An all-lowercase word is usually English, not a base64 payload.
  return /[A-Z0-9+/]/.test(token);
}

function decodeBase64Token(token: string): string | undefined {
  if (!looksLikeEncodedBase64(token)) return undefined;
  const bytes = Buffer.from(token, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== token) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text === token) return undefined;
    if (hasDisallowedControl(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): string[] {
  const found: string[] = [];
  const trimmed = value.trim();
  const whole = decodeBase64Token(trimmed);
  if (whole !== undefined) found.push(whole);
  if (!/\s/.test(trimmed)) return found;
  for (const token of trimmed.split(/\s+/)) {
    if (token === trimmed) continue;
    const decoded = decodeBase64Token(token);
    if (decoded !== undefined) found.push(decoded);
  }
  return found;
}

function decodeOnce(value: string): string[] {
  const out: string[] = [];
  const html = decodeHtml(value);
  if (html !== undefined) out.push(html);
  const url = decodeUrl(value);
  if (url !== undefined) out.push(url);
  for (const text of decodeBase64(value)) out.push(text);
  return out;
}

function matchVariants(value: string): string[] {
  const seen = new Set<string>([value]);
  const ordered = [value];
  let layer = [value];
  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const item of layer) {
      for (const decoded of decodeOnce(item)) {
        if (seen.has(decoded)) continue;
        seen.add(decoded);
        ordered.push(decoded);
        next.push(decoded);
      }
    }
    layer = next;
  }
  return ordered;
}

/**
 * Folded strings to test: the raw text, each decode up to depth 2, and the
 * same after format characters are removed (so a zero-width split inside a
 * base64 token is joined before the decode).
 */
export function scanVariants(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (text: string) => {
    const folded = foldForMatch(text);
    if (seen.has(folded)) return;
    seen.add(folded);
    out.push(folded);
  };
  for (const variant of matchVariants(value)) add(variant);
  const folded = foldForMatch(value);
  if (folded !== value) {
    for (const variant of matchVariants(folded)) add(variant);
  }
  return out;
}

/** Phrase key for an already folded variant. */
export function phraseKey(folded: string): string {
  return collapsePhrase(folded);
}
