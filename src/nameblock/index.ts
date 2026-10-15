/**
 * Barrel for the name block.
 * Implement the guard in `src/guard/`. This file stays a re-export so the
 * critical-core path and the component name point at the same code.
 */
export {
  createContentGuard,
  createPrivacyGuard,
  decodeUtf8Text,
  fileBodyIsScanned,
  guard,
  screenContent,
} from "../guard/index.js";
