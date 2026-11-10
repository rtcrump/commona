/**
 * Barrel for the name block.
 * Implement the guard in `src/guard/`. This file stays a re-export so the
 * critical-core path and the component name point at the same code.
 */
export { createContentGuard, decodeUtf8Text, fileBodyIsScanned, guard } from "../guard/index.js";
