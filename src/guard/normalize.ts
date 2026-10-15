/**
 * Text the privacy filter matches on.
 *
 * Format characters (Unicode Cf, including U+200B, U+200C, U+200D, U+2060, and
 * U+FEFF) are removed. U+2028 and U+2029 stay as line breaks so a date on the
 * next line is not a date of birth. Look-alike Greek and Cyrillic letters fold
 * to Latin. Base64, URL encoding, and HTML entities are decoded at most
 * {@link DECODE_DEPTH_LIMIT} times. A third wrapping is a known limit.
 */

/** A third encoding is not decoded. */
export const DECODE_DEPTH_LIMIT = 2;

const MAX_VARIANTS = 8;
const MAX_DECODED_CHARS = 100_000;
const MIN_BASE64_CHARS = 16;

const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Letters that are commonly typed in place of Latin.
 * The fold is one way: a Latin letter is never rewritten.
 */
const CONFUSABLES = new Map<string, string>([
  ["Α", "A"],
  ["Β", "B"],
  ["Ε", "E"],
  ["Ζ", "Z"],
  ["Η", "H"],
  ["Ι", "I"],
  ["Κ", "K"],
  ["Μ", "M"],
  ["Ν", "N"],
  ["Ο", "O"],
  ["Ρ", "P"],
  ["Τ", "T"],
  ["Υ", "Y"],
  ["Χ", "X"],
  ["ε", "e"],
  ["ι", "i"],
  ["κ", "k"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  ["А", "A"],
  ["а", "a"],
  ["В", "B"],
  ["Е", "E"],
  ["е", "e"],
  ["К", "K"],
  ["к", "k"],
  ["М", "M"],
  ["м", "m"],
  ["Н", "H"],
  ["н", "h"],
  ["О", "O"],
  ["о", "o"],
  ["Р", "P"],
  ["р", "p"],
  ["С", "C"],
  ["с", "c"],
  ["Т", "T"],
  ["т", "t"],
  ["У", "Y"],
  ["у", "y"],
  ["Х", "X"],
  ["х", "x"],
  ["І", "I"],
  ["і", "i"],
  ["Ј", "J"],
  ["ј", "j"],
  ["Ѕ", "S"],
  ["ѕ", "s"],
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/** Line separators become newlines, then Cf is stripped, NFKC is applied, and look-alikes fold. */
export function prepareForScan(value: string): string {
  const lined = value.replace(/\u2028|\u2029/g, "\n");
  const stripped = stripFormat(lined).normalize("NFKC");
  return foldConfusables(stripFormat(stripped));
}

/** The raw string plus decodings up to {@link DECODE_DEPTH_LIMIT}. */
export function expansionTexts(value: string): string[] {
  const seen = new Set<string>([value]);
  let layer = [value];
  for (let depth = 0; depth < DECODE_DEPTH_LIMIT; depth += 1) {
    const next: string[] = [];
    for (const text of layer) {
      for (const decoded of decodeOnce(text)) {
        if (seen.has(decoded) || decoded.length > MAX_DECODED_CHARS) continue;
        seen.add(decoded);
        next.push(decoded);
        if (seen.size >= MAX_VARIANTS) return [...seen];
      }
    }
    layer = next;
  }
  return [...seen];
}

function stripFormat(value: string): string {
  return value.replace(FORMAT_CHARS, "");
}

function foldConfusables(value: string): string {
  let out = "";
  for (const char of value) {
    out += CONFUSABLES.get(char) ?? char;
  }
  return out;
}

function decodeOnce(value: string): string[] {
  const found: string[] = [];
  const url = decodeUrl(value);
  if (url !== undefined) found.push(url);
  const html = decodeHtml(value);
  if (html !== undefined) found.push(html);
  const tokens = new Set<string>();
  const whole = value.trim();
  if (whole.length > 0) tokens.add(whole);
  for (const part of value.split(/\s+/)) {
    if (part.length > 0) tokens.add(part);
  }
  for (const token of tokens) {
    const text = decodeBase64Token(token);
    if (text !== undefined) found.push(text);
  }
  return found;
}

function decodeUrl(value: string): string | undefined {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function decodeHtml(value: string): string | undefined {
  if (!/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.test(value)) return undefined;
  const decoded = value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return codePoint(code) ?? whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
  return decoded === value ? undefined : decoded;
}

function codePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  if (code >= 0xd800 && code <= 0xdfff) return undefined;
  return String.fromCodePoint(code);
}

function decodeBase64Token(token: string): string | undefined {
  if (token.length < MIN_BASE64_CHARS || token.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64");
  if (bytes.toString("base64") !== token) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!isReadable(text) || text === token) return undefined;
  return text;
}

function isReadable(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DECODED_CHARS) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd) return false;
  }
  return true;
}
