# Agent notes

## Code Review Rules

Codex reviews against this list. Flag a finding as P0 or P1 only when it matches. Known limits listed in SECURITY.md are not findings. Style nits are not findings.

Safety-core is `src/guard`, `src/sharing`, `src/audit`, `src/auth`, `contract/`, and the wiring in `src/app.ts`.

P0/P1 covers anything that could:

- leak data across owners
- let a patient name, health number, or date of birth through, apart from the known limits in SECURITY.md
- edit, delete, or truncate audit entries undetected
- bypass the loop limit
- skip join auth

Real data in fixtures is P0. Changing acceptance test wording is P1.
