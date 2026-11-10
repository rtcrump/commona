# Claude Code milestone review

Grok Bot runs this review on roboRazer. Each run needs Trafford's yes. It uses his Claude Code subscription and no API key.

## When

Run the review at a milestone:

- before a promotion to main
- before outside testers
- before a launch or deploy
- on any pull request that touches safety-core, patient-data, or secrets paths

A safety-core pull request, or one with the `critical-core` label, is a milestone. The label alone is enough. The paths are in `AGENTS.md` and `.github/safety-core-paths.txt`. The skill is `.claude/skills/commona-safety-review/SKILL.md`.

The reviewer does not commit. Fix rounds stop at 3, then escalate.

## How it is recorded

The record is one pull request comment:

```
## Claude Code milestone review
Head: <full commit SHA>
Verdict: CLEAN
```

`Head` is the full commit SHA. When the review has a P0 or a P1, the verdict line is `Verdict: FINDINGS`, then the P0/P1 list.
