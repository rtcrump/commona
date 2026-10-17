/**
 * Places a test needs something the contract does not name or does not pin down.
 * These are reported on every `npm run m1` run. They are not skips.
 */
export const CONTRACT_GAPS = [
  "The contract does not name the database file the process opens. The harness sets COMMONA_DB to a fresh file and seeds the fixtures there. A server that opens a different file cannot satisfy the tests.",
  "The contract does not name an SMTP host or port. The harness sets COMMONA_SMTP_HOST and COMMONA_SMTP_PORT to an in-process sink. W2's email fallback has no contract field that points at that sink.",
  "buildApp() takes no database, token store, clock, or mailer. The harness starts that app and calls the src/auth and src/audit entry points. It cannot inject those dependencies through a contract type.",
  "There is no route to change an agent's webhook. The harness listens on the URLs in fixtures/agents.json. Wakes arrive only if the server posts to those stored URLs.",
  "There is no GET for sharing rows. S5 reads the sharing table from SCHEMA_SQL and checks that A2's feed is empty.",
  "There is no route that returns the whole audit chain. L1 reads GET /log?owner= for each fixture owner and calls audit.verify() for the chain.",
  "A successful GET /log is not specified as an audit row. The harness does not expect one. A cross-owner log read is specified as read/refused. If a successful log read is also appended, L1's multiset will not match.",
  "The harness expects one read/ok per feed GET, including an empty feed, and one read/ok per successful file download. The contract does not say whether an empty feed is logged, or one row versus one row per item. A hidden file's 404 is not expected in the log.",
  "W2's spec says at least one retry. The contract logs each failed attempt that will be retried as wake_retry/retried, and there are three delays before the fourth attempt. The harness expects three wake_retry rows, then wake_fallback_email or wake_failed, and no separate row for the fourth failed attempt.",
  "The 60 second bound is in the W1 sentence. The contract exports the webhook timeout and the retry delays, not that bound.",
  "The contract allows http wake webhooks only for localhost or 127.0.0.1, and only when a dev flag is set. It does not name the variable. The harness sets COMMONA_ALLOW_INSECURE_WEBHOOKS=1 because fixtures/agents.json uses http://127.0.0.1. The 19 sentences are unchanged.",
] as const;

/** Readings the contract can express. Recorded so they are not mistaken for wording changes. */
export const HARNESS_NOTES = [
  "R1's sentence does not mention sharing, and the default level is None, which hides the post. The harness follows the T2 procedure and sets both directions to messages_files with PUT /rooms/:roomId/sharing before A2 reads. The contract has no separate test-only sharing helper.",
  "An accepted post or upload wakes every other member. Those wake/ok rows are part of L1 for R1, R3, S1, S2, S3, S5, P1, P2, P3, and P5. P4 keeps A2 out of the room, so that test expects no wake.",
  "W3's line that A1's webhook receives nothing would pass if the server sent no webhooks. The harness also requires A2 to receive that wake.",
  "L3 filters on ownerId, so rows filed as owner:O2 are visible to O2. The harness asserts ownerId O2, which is what GET /log returns.",
  "S4 logs O2's refusal as agent id owner:O2. The T3 line says the attempt is logged with A2/O2.",
  "POST /rooms has no audit action. The harness expects no log row for creating a room. Each successful membership is one join/ok filed under the member.",
  "W1 and W2 post to the http://127.0.0.1 URLs in fixtures/agents.json. The harness sets COMMONA_ALLOW_INSECURE_WEBHOOKS=1 so those URLs are accepted. The test sentences are unchanged.",
] as const;
