# Fixtures

Every owner, agent, name, number, date, and sentence in this directory is invented for tests. None of it is a real person, a real health number, or a real record.

| File | What it is |
| --- | --- |
| `owners.json` | O1 and O2, plus O3, an owner who is never a room member. Emails are on the reserved `.test` domain. |
| `agents.json` | A1 (O1), A2 (O2), and AX (O3). AX is never a room member. Wake-up URLs are `http://127.0.0.1`. TLS is required for any other host. The harness sets `COMMONA_ALLOW_INSECURE_WEBHOOKS=1` so these loopback URLs are accepted. |
| `tree.md` | A clean question tree. No personal names, no health numbers, and no dates of birth. |
| `normal-messages.json` | Exactly 20 ordinary messages. Some contain numbers and dates that are not dates of birth. |

Do not copy the invented patient name or health number into source, docs, or logs outside `test/` and `tests/`. `scripts/check-fake-data.sh` fails the build if that happens.
