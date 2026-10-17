# Commona commit-note and label conventions (DRAFT, awaiting G1/G2)
Enforced by `check/scripts/check_conventions.py`, run in CI by `check/.github/workflows/conventions.yml`.

## 1. Commit subject
`<type>(<component>): <summary>` — max 72 chars, lower-case type.
- type: `feat fix test docs chore ci refactor`
- component: `room wake sharing audit loop data ci docs tracking m1 release readme demo`
- Example: `feat(sharing): add per-owner levels with None default`

## 2. Commit trailers (git trailer block at end of message)
Every commit must declare authorship, exactly one of:
- Agent: `Authored-by-agent: cursor/<agent-id>` **and** `Model: <model>` (both required).
  Grok Build: `Authored-by-agent: grok/<agent-id>` **and** `Model: <model>`.
  Community agents: `Authored-by-agent: community/<github-user>/<tool>` + `Model:`.
- Human: `Authored-by: human/<name>` (any human edit, including emergency fixes). Never both.

Optional while the PR is open, **required on what lands on main** (squash-merge commit):
- `QA: chatgpt round <1|2|3> pass` (a `fail` value may appear on branch commits, never on main)
- `Approved-by: trafford`
Allowed trailer keys are only those above plus `Co-authored-by:` and `Refs: T<n>` (spec id). Unknown `*-by:`-style keys fail (stops typos like `Authored-By-Agent`).
Merge commits from GitHub (`Merge pull request #...`) are skipped; we squash-merge.

## 3. PR labels
- At least one author label from `agent:cursor`, `agent:grok-build`, `agent:community`, `human-edit`. `agent:cursor`, `agent:grok-build`, and `agent:community` are mutually exclusive.
- `human-edit` is present if and only if some commit in the PR has `Authored-by: human/...`.
- `critical-core` required if the PR touches any critical path (`src/sharing/`, `src/audit/`, `src/auth/`, `src/room/membership*`); it then requires G3 review.
- QA labels: at most one of `qa-round-1`, `qa-round-2`, `qa-round-3`. `agent:chatgpt-qa` is set once QA has posted any report.
- To be mergeable (`--mode merge`): one `qa-round-N` label and `agent:chatgpt-qa` present.

## 4. Bot identity
Cursor agents commit as a dedicated bot account (name TBD at G2, e.g. `commona-bot`). Commits by the bot identity with an `Authored-by: human/` trailer fail (identity mismatch).

## 5. Stats
`Written by agents: NN%` is computed from these trailers only (lines via `git log --numstat`, commits by trailer). Never typed by hand.

## 6. Squash-merge to main
The G4 merge step writes `QA: chatgpt round <n> pass` and `Approved-by: trafford` into the squash message; the push-to-main check fails otherwise.
