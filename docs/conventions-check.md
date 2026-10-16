# Conventions check
- `scripts/check_conventions.py` — stdlib Python checker for commit subjects, trailers and PR labels (rules in [conventions.md](conventions.md)).
- `scripts/test_check_conventions.py` — 58 self-tests: 16 commit must-pass, 22 commit must-fail, 5 label must-pass + 1 non-critical-path pass, 10 label must-fail groups, 4 end-to-end runs on a throwaway local git repo. The trailer-block cases are shared with the badge parser in `scripts/trailer-block-spec.json`.
- `.github/workflows/conventions.yml` — runs the self-test, then checks PR commits + labels, merge readiness (informational until branch protection exists), and commits pushed to main.
- Run locally: `python3 scripts/test_check_conventions.py`.
- The checker accepts the older one-line trailer `Agent: grok-build` as grok authorship. Bot email in `BOT_EMAILS` is `commona-bot@users.noreply.github.com`.
- The squash-merge commit on main must carry `QA:` and `Approved-by: trafford`. The merge step adds them to the squash message, otherwise the push-to-main check fails.
- This checker does not edit `README.md`. The agent-written badge stays on the milestone README.
