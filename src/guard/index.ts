import type { ContentGuard, GuardDecision, GuardTarget } from "../../contract/index.js";
import { todo } from "../todo.js";

/**
 * T4. Critical core: the patient-name block.
 * The component name in commit subjects is `nameblock`.
 * This folder is `src/guard/` because that is the critical-core path.
 */
export const guard: ContentGuard = {
  check(_target: GuardTarget): GuardDecision {
    return todo("nameblock");
  },
};
