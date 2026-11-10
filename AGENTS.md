# House rules for AI agents
- Normal merge commits only. Never squash, rebase or force-push.
- Never read, print or write secrets, tokens or .env files.
- Never touch real or de-identified patient data, or any nevisight folder.
- Never send email or messages, post or deploy. Draft only. Cloud and build agents never merge. The venture COO may merge docs, ops, and non-safety PRs with a normal merge commit once Codex and CI are clean; safety-related merges still need Trafford.
- Keep changes small and say what you changed and why.

# Agent notes

## Code Review Rules

Codex reviews against this list. Flag a finding as P0 or P1 only when it matches. Known limits listed in SECURITY.md are not findings. Style nits are not findings.

Safety-core paths are listed under Safety-core review.

P0/P1 covers anything that could:

- leak data across owners
- let a patient name, health number, or date of birth through, apart from the known limits in SECURITY.md
- edit, delete, or truncate audit entries undetected
- bypass the loop limit
- skip join auth

Real data in fixtures is P0. Changing acceptance test wording is P1.

## Safety-core review

Reviewers only review. They do not commit or push.

These paths are safety-core. They are the name block, sharing, the audit log, sign-in, the contract, and the server wiring that connects them:

- `src/guard/` and `src/nameblock/` — the name block. `src/nameblock/` re-exports `src/guard/`.
- `src/sharing/` and `src/room/sharing.ts` — per-owner sharing.
- `src/audit/` — the audit log.
- `src/auth/`, `src/room/access.ts`, `src/room/membership.ts`, and `src/room/routes.ts` — bearer tokens, join, and the membership check.
- `contract/` — the shared types those modules implement.
- `src/app.ts` and `src/runtime.ts` — the wiring that builds the server from those modules.
- `src/host/host-room.ts` is the host-only room route. It checks the host secret and records a refusal. Trafford reads that file line by line.

The same list is `.github/safety-core-paths.txt`. A pull request that changes one of these paths, or that carries the `critical-core` label, is a safety-core pull request. The label alone is enough.

A safety-core pull request also needs a clean Claude Code milestone review on its final head before merge.

Codex reviews a safety-core pull request. A clean review has no P0 and no P1. A Copilot review is advisory only. It is filed and does not decide the pass.

The Claude Code milestone review is not an Actions check. The skill is `.claude/skills/commona-safety-review/SKILL.md`. Who runs it, when, and how the comment is recorded are in `docs/claude-milestone-review.md`. A safety-core pull request, or one with the `critical-core` label, is a milestone. The reviewer does not commit.

Trafford still reads the safety-core diff line by line. Safety-related pulls still need Trafford's yes. The venture COO may merge docs, ops, and non-safety pulls under standing rules.

Fix rounds stop at 3. After the third round, escalate instead of pushing another fix.
