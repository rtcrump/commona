import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Opt-in showroom list. Off unless an owner's filter names this id. */
export const CLARITY_PRESET_ID = "clarity-demo";

interface PresetManifest {
  id?: unknown;
  termsFile?: unknown;
}

let cachedTerms: readonly string[] | undefined;
let failed = false;

/**
 * Terms for one preset. `undefined` means the preset could not be read.
 * A filter that names an unreadable preset fails closed.
 */
export function loadPresetTerms(presetId: string): readonly string[] | undefined {
  if (presetId !== CLARITY_PRESET_ID) return undefined;
  if (failed) return undefined;
  if (cachedTerms) return cachedTerms;
  try {
    const manifestPath = fileURLToPath(new URL("../../presets/clarity-demo/preset.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PresetManifest;
    if (manifest.id !== CLARITY_PRESET_ID || typeof manifest.termsFile !== "string") {
      failed = true;
      return undefined;
    }
    const termsPath = path.resolve(path.dirname(manifestPath), manifest.termsFile);
    const terms = readFileSync(termsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (terms.length === 0) {
      failed = true;
      return undefined;
    }
    cachedTerms = terms;
    return cachedTerms;
  } catch {
    failed = true;
    return undefined;
  }
}
