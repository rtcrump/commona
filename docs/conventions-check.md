# Conventions check
- `scripts/check_conventions.py` — stdlib Python checker for commit subjects, trailers and PR labels (rules in [conventions.md](conventions.md)).
- `scripts/test_check_conventions.py` — 70 self-tests: 19 commit must-pass, 25 commit must-fail, 5 label must-pass + 1 non-critical-path pass, 10 label must-fail groups, 8 end-to-end runs on a throwaway local git repo, 2 grandfather checks against m1-integration history (squash `d376da6` and the full range). The trailer-block cases are shared with the badge parser in `scripts/trailer-block-spec.json`.
- `.github/workflows/conventions.yml` — runs the self-test, then checks PR commits + labels, merge readiness (informational until branch protection exists), and commits pushed to main.
- Run locally: `python3 scripts/test_check_conventions.py`.
- The checker script and its tests are copied unchanged. Bot email in `BOT_EMAILS` is `commona-bot@users.noreply.github.com`.
- Main mode requires `QA: chatgpt round <n> pass` and `Approved-by: trafford` on the merge commit that lands a PR (and on a first-parent squash), not on the agent commits inside the PR. The merge step adds the trailers to the merge commit message, otherwise the push-to-main check fails. Commits reachable from `4bbbbe4` are grandfathered, including squash `d376da6` (PR #63).
- This checker does not edit `README.md`. The agent-written badge stays on the milestone README.
