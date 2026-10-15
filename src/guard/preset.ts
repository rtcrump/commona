import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Opt-in list of invented showroom names. Off unless an owner's row names it. */
export const CLARITY_PRESET = "clarity-demo";

let clarityNames: readonly string[] | undefined;

/** Names from `presets/clarity-demo/names.txt`. Throws when the file is missing or empty. */
export function loadClarityNames(): readonly string[] {
  if (clarityNames) return clarityNames;
  const names = readFileSync(clarityNamesFile(), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (names.length === 0) throw new Error("clarity demo preset has no names");
  clarityNames = names;
  return names;
}

/**
 * `src/guard` and `dist/src/guard` sit at different depths.
 * The first existing file wins so a built server still finds the preset.
 */
function clarityNamesFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../presets/clarity-demo/names.txt"),
    path.resolve(here, "../../../presets/clarity-demo/names.txt"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("clarity demo preset is missing");
}
