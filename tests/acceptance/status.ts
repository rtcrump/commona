import { ACCEPTANCE_TESTS } from "../../contract/index.js";

/**
 * T7 replaces `npm run m1` and fills this folder with the 19 acceptance tests.
 * Do not add skipped tests here. A test that cannot run is a failure, reported as a failure.
 */
export const acceptanceHarnessStatus = "todo" as const;

export const acceptanceTestIds = ACCEPTANCE_TESTS.map((test) => test.id);
