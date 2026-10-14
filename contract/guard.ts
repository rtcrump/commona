export const BlockCategory = {
  Name: "name",
  HealthNumber: "health_number",
  Dob: "dob",
} as const;

export type BlockCategory = (typeof BlockCategory)[keyof typeof BlockCategory];

export const BLOCK_CATEGORIES = [
  BlockCategory.Name,
  BlockCategory.HealthNumber,
  BlockCategory.Dob,
] as const;

export const BlockLocation = {
  Text: "text",
  FileBody: "file_body",
  FileName: "file_name",
  FileMeta: "file_meta",
} as const;

export type BlockLocation = (typeof BlockLocation)[keyof typeof BlockLocation];

export const BLOCK_LOCATIONS = [
  BlockLocation.Text,
  BlockLocation.FileBody,
  BlockLocation.FileName,
  BlockLocation.FileMeta,
] as const;

/** Five digits, an optional space or hyphen, then four digits. */
export const HEALTH_NUMBER_PATTERN = String.raw`\b\d{5}[- ]?\d{4}\b`;

/** Case-insensitive cues. A date counts only when one of these sits near it. */
export const DOB_CUES = ["dob", "d.o.b.", "date of birth", "born"] as const;

/** Maximum characters between a cue and a date on the same line. */
export const DOB_CUE_WINDOW_CHARS = 40;

export const DOB_MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
] as const;

/**
 * Media types whose decoded bytes are scanned as text.
 * Anything else, including images and PDFs, is not byte-scanned in M1.
 * The file name and metadata are still scanned.
 */
export const TEXT_MEDIA_TYPE_PREFIX = "text/";

export const TEXT_MEDIA_TYPES = ["application/json"] as const;

export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_CHARS = 200;

export interface GuardTarget {
  kind: "message" | "file";
  /** Message text, or the decoded file body when that body is scanned as text. */
  text?: string;
  fileName?: string;
  /** User-supplied keys and values. Both are scanned. */
  metadata?: Readonly<Record<string, string>>;
}

export interface GuardHit {
  category: BlockCategory;
  location: BlockLocation;
}

export interface GuardDecision {
  outcome: "allow" | "block";
  /**
   * Every hit. The audit row stores the first hit in scan order:
   * file name, then metadata keys in sorted order, then text or file body.
   * Within one location the category order is name, health_number, dob.
   */
  hits: readonly GuardHit[];
}

export interface ContentGuard {
  check(target: GuardTarget): GuardDecision;
}

/**
 * Name matching the implementation must follow:
 * 1. Normalize with NFKC, lowercase, and map `_`, `-`, and `.` to spaces.
 * 2. Collapse runs of whitespace.
 * 3. A list entry hits when its normalized form is a substring of the normalized field.
 * 4. Matching is the whole list phrase, not each word on its own.
 *
 * The name list is injected (default `fixtures/names.txt`). The guard has no switch
 * to turn it off.
 */
export const NAME_MATCH_STEPS = [
  "nfkc",
  "lowercase",
  "separators-to-space",
  "collapse-whitespace",
  "phrase-substring",
] as const;

export const NAME_BLOCK_KNOWN_LIMIT =
  "Misspellings and names that are not on the list may get through. Image and PDF bytes are not scanned in M1. File names and file details are still checked.";

/** The block has no off switch in M1. */
export const GUARD_ALWAYS_ON = true;
