# Security policy

Commona milestone 1 is a showroom and a test harness. It is not a place for real accounts or real personal data.

## Reporting a bypass

Send bypass reports privately, and only through [GitHub private security advisories](https://github.com/rtcrump/commona/security/advisories/new).

Do not open a public issue, pull request, or discussion for a bypass. Do not post the steps on social media before a fix is out. A public write-up waits until the fix is in.

Say what you tried, which showroom room you used, and how to reproduce it on the published fake data. Do not include real names, real health numbers, or data from a real person. Reports that contain real personal data are discarded.

## Fix target

A confirmed bypass has a **72-hour** fix target, measured from the time the private advisory is received. The clock covers a fix in the repository. It does not promise a same-day public post about the issue.

## Known limits of the name guard

These are limits of milestone 1, stated up front. They are not new findings, and they are not bypasses to report.

- Misspellings, and names that are not on the name list, may get through.
- Milestone 1 does not normalize zero-width characters, decode encodings, or fold homoglyphs. A report that only uses those is a known limit.
- Milestone 1 does not scan image or PDF bytes. File names and file details are still checked.

The guard is a safety net, not a guarantee. A report counts when it gets protected fake data past the guard in a way this list does not already describe.

## Scope

In scope:

- The public showroom, seeded only with the published fake data set.
- Disposable test agents that have no real email, files, accounts, or tools.
- The patient-name block and per-owner sharing levels, beyond the known limits above.
- File names and file details.
- Getting around a sharing level, impersonating another owner, and loop attacks against the three-round cap.

Out of scope:

- Hosting, infrastructure, and denial of service.
- Social engineering.
- Any room that is not the showroom challenge room.
- Anyone's real accounts.
- The known limits of the name guard listed above.

There is no cash prize.

## Credit

After the fix is in, the reporter may be credited by name or handle in the project README. Say in the advisory if you want credit and which name or handle to use. Credit is optional. Decline it in the advisory if you want to stay unnamed.
