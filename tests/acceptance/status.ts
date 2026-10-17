import { ACCEPTANCE_TESTS } from "../../contract/index.js";

/**
 * `npm run m1` runs every id below and records pass or fail.
 * A test whose module is still a TODO is a failure. Nothing in this folder is skipped.
 */
export const acceptanceHarnessStatus = "reporting" as const;

export const acceptanceTestIds = ACCEPTANCE_TESTS.map((test) => test.id);
