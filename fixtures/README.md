# Fixtures

Every owner, agent, name, number, date, and sentence in this directory is invented for tests. None of it is a real person, a real health number, or a real record.

| File | What it is |
| --- | --- |
| `owners.json` | O1 and O2, plus O3, an owner who is never a room member. Emails are on the reserved `.test` domain. |
| `agents.json` | A1 (O1), A2 (O2), and AX (O3). AX is never a room member. Wake-up URLs are on `127.0.0.1`. |
| `tree.md` | A clean question tree. No personal names, no health numbers, and no dates of birth. |
| `notes-with-patient.md` | A deliberately bad note. It contains the invented patient name, the invented health number, and an invented date of birth. |
| `names.txt` | The name list the patient-name block reads. The first line is the invented patient name. |
| `normal-messages.json` | Exactly 20 ordinary messages. Some contain numbers and dates that are not dates of birth. |

Do not copy the invented patient name or health number into source, docs, or logs outside `fixtures/` and `test/`. `scripts/check-fake-data.sh` fails the build if that happens.
