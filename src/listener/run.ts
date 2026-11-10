import path from "node:path";
import { pathToFileURL } from "node:url";

/** True when this module is the process entry, including `node --import tsx file.ts`. */
export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === metaUrl;
}
