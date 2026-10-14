# Acceptance tests

This folder is the home of the one-command M1 run (`npm run m1`).

T0 does not own any of the 19 tests. Later specs add their own tests under `test/<component>/`, named with the acceptance id (`test_R1_a1_posts_a2_reads` and so on). T7 runs all 19 in order on a fresh database and writes `m1-report.md` and `m1-report.json`.

`npm run m1` is a placeholder until then. It prints that the tests were not run, and it exits 0 so the script exists. It does not claim a pass.

Do not mark a test skipped to make the build green.
