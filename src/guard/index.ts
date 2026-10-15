import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TEXT_MEDIA_TYPE_PREFIX,
  TEXT_MEDIA_TYPES,
  type ContentGuard,
  type GuardDecision,
  type GuardTarget,
} from "../../contract/index.js";
import { scanContent } from "./scan.js";

/**
 * Injected-list guard.
 *
 * `guard` still loads `fixtures/names.txt` so the name-block unit tests have
 * a list to scan. The server does not use that object. The live check is
 * `createPrivacyGuard` in `filter.ts`: each owner's terms and pattern flags,
 * with the Clarity demo preset off unless that owner turns it on.
 *
 * Matching folds format characters, look-alike letters, and up to two layers
 * of base64, URL encoding, and HTML entities. See `normalize.ts`.
 */

export { MAX_DECODE_DEPTH, normalizeForNameMatch } from "./normalize.js";

/** Names are injected. The list is the caller's. Patterns stay on. */
export function createContentGuard(names: readonly string[]): ContentGuard {
  return {
    check(target: GuardTarget): GuardDecision {
      const hits = scanContent(target, names, { healthNumber: true, dob: true });
      return { outcome: hits.length === 0 ? "allow" : "block", hits };
    },
  };
}

function readDefaultNames(): readonly string[] {
  const file = fileURLToPath(new URL("../../fixtures/names.txt", import.meta.url));
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Unit-test list. The server uses the per-owner filter instead. */
export const guard: ContentGuard = createContentGuard(readDefaultNames());

/**
 * The contract target has no owner field. The live filter reads `ownerId`
 * from this object. Injected test guards ignore the extra property.
 */
export function scopeGuardTarget(ownerId: string, target: GuardTarget): GuardTarget {
  const scoped: GuardTarget & { ownerId: string } = { ...target, ownerId };
  return scoped;
}

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
