# Acceptance tests

`npm run m1` runs the 19 M1 tests in order on a fresh database: R1–R3, W1–W3, S1–S5, P1–P5, then L1–L3.

The wording of each test is the plan sentence, mapped to its id in `catalog.ts`. The tests call the HTTP API and the auth and audit entry points. They do not implement room, wake-up, sharing, the name block, or the log.

The command prints a pass or fail for every id and writes `m1-report.md` and `m1-report.json`. A missing module is a failure, marked `not-built`. The process exits non-zero when any test fails.

`npm test` does not run this folder. CI stays on `npm test`, so a red acceptance run does not fail that job.

Do not mark a test skipped to make the build green.
