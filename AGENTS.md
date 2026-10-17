# Agent notes

## Code Review Rules

Codex reviews against this list. Flag a finding as P0 or P1 only when it matches. Known limits listed in SECURITY.md are not findings. Style nits are not findings.

Safety-core paths are listed under Safety-core review.

P0/P1 covers anything that could:

- leak data across owners
- edit, delete, or truncate audit entries undetected
- bypass the loop limit
- skip join auth

Real data in fixtures is P0. Changing acceptance test wording is P1.

## Safety-core review

Reviewers only review. They do not commit or push.

These paths are safety-core. They are sharing, the audit log, sign-in, the contract, and the server wiring that connects them:

- `src/sharing/` and `src/room/sharing.ts` — per-owner sharing.
- `src/audit/` — the audit log.
- `src/auth/`, `src/room/access.ts`, `src/room/membership.ts`, and `src/room/routes.ts` — bearer tokens, join, and the membership check.
- `contract/` — the shared types those modules implement.
- `src/app.ts` and `src/runtime.ts` — the wiring that builds the server from those modules.

The same list is `.github/safety-core-paths.txt`. A pull request that changes one of these paths, or that carries the `critical-core` label, is a safety-core pull request. The label alone is enough.

A safety-core pull request passes only when both the Codex review and the Claude review are clean, with no P0 and no P1. A Copilot review is advisory only. It is filed and does not decide the pass.

Trafford still reads the safety-core diff line by line. Trafford is the only one who merges.

Fix rounds stop at 3. After the third round, escalate instead of pushing another fix.
