---
name: commona-safety-review
description: Review one named pull request for safety-core defects only. Use on a milestone, including a safety-core pull request and a pull request with the critical-core label.
---

# Commona safety review

Review the named pull request for safety-core defects only. Read the diff, then read only the safety-core files that diff touches, plus AGENTS.md, SECURITY.md, and .github/safety-core-paths.txt. Flag P0 or P1 when a change could leak data across owners; let a patient name, health number, or date of birth through, apart from the known limits in SECURITY.md; edit, delete, or truncate audit entries undetected; bypass the loop limit; or skip join auth. Real data in fixtures is P0. Changing acceptance test wording is P1. Known limits and style nits are not findings. A clean review has no P0 and no P1. Do not commit. Do not push. Do not edit files. Do not open a branch or a pull request. Reviewers only review. Do not retry a tool that was denied.

## Safety-core paths

These paths are safety-core. They are the name block, sharing, the audit log, sign-in, the contract, and the server wiring that connects them:

- `src/guard/` and `src/nameblock/` — the name block. `src/nameblock/` re-exports `src/guard/`.
- `src/sharing/` and `src/room/sharing.ts` — per-owner sharing.
- `src/audit/` — the audit log.
- `src/auth/`, `src/room/access.ts`, `src/room/membership.ts`, and `src/room/routes.ts` — bearer tokens, join, and the membership check.
- `contract/` — the shared types those modules implement.
- `src/app.ts` and `src/runtime.ts` — the wiring that builds the server from those modules.
- `src/host/host-room.ts` is the host-only room route. It checks the host secret and records a refusal. Trafford reads that file line by line.

The same list is `.github/safety-core-paths.txt`:

```
src/guard/
src/nameblock/
src/sharing/
src/audit/
src/auth/
src/room/access.ts
src/room/membership.ts
src/room/routes.ts
src/room/sharing.ts
src/app.ts
src/runtime.ts
src/host/host-room.ts
contract/
```

## Milestone

A safety-core pull request, or one with the `critical-core` label, is a milestone. The reviewer still cannot commit.

Fix rounds stop at 3, then escalate.

## Record

Post one pull request comment, then stop. That comment is the record.

```
## Claude Code milestone review
Head: <full commit SHA>
Verdict: CLEAN
```

`Head` is the full commit SHA of the pull request head. When the review has a P0 or a P1, write `Verdict: FINDINGS` and then the P0/P1 list.
