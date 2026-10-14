# M1 wiring decisions

The contract leaves these open. Each choice is the smallest one that the modules and the harness can both mean. The 19 test sentences are unchanged.

## Database path

`buildApp()` with no arguments opens `COMMONA_DB`. When that variable is unset, it opens `:memory:`. The harness sets `COMMONA_DB` to a fresh file, seeds the fixtures, and then starts the server. `tokens` and `audit` are the same process-wide objects, on that same file, so a token issued by the harness is the token the server checks, and `audit.verify()` reads the chain the server wrote.

A caller that passes `db` gets that database instead. Room and audit tests do this. They do not share the process-wide file.

The file is opened in WAL mode with a 5 second busy timeout, so the harness can read `sharing` and tamper a copy of the log while the server is up.

## SMTP and buildApp injection

`buildApp()` still accepts the dependencies the unit tests inject: database, clock, tokens, audit, sharing, guard, notices, wake queue, and SMTP. The harness calls `buildApp()` with no arguments. That path reads the environment.

SMTP is `COMMONA_SMTP_HOST` and `COMMONA_SMTP_PORT`, and only when both are set. The harness points them at its in-process sink. A missing pair means mail is not sent. Wake delivery then ends as `wake_failed`. A block notice is still stored.

Injecting `db` does not read the SMTP environment. A test that wants mail passes `smtp`.

## Webhook URLs

There is no route to change an agent's webhook. Delivery posts to `agents.webhook_url`, which the fixture seed copies from `fixtures/agents.json`. The harness listens on those URLs.

## A successful GET /log is not audited

A successful `GET /log?owner=` returns that owner's rows and appends nothing. A missing or unknown token is `401` and is not audited. A malformed `owner` query is `400` and is not audited. A known caller who is not that owner is `403`, and the refusal is `read` / `refused` under the caller.

The harness already expects no row for a successful log read. L1's multiset would fail if one were added. This choice keeps that assertion as it is.

A successful `GET /notices` is also not audited, for the same reason: W2, W3, and P1 read notices, and those rows are not in the expected multiset. An agent calling `GET /notices` is `403` and that refusal is audited. The harness does not do that.

## read / ok granularity

One `read` / `ok` per successful feed GET, including an empty feed. One `read` / `ok` per successful file download. A hidden file and a missing file are both `404` and are not audited. The harness already counts rows that way.

## W2 retry rows

A failed webhook attempt that will be retried is one `wake_retry` / `retried`. The delays are 2s, 8s, and 20s, so three of those rows, then the fourth attempt. The fourth failure has no row of its own. Email after that is `wake_fallback_email` / `fell_back`. If email also fails, the row is `wake_failed` / `failed`. The harness already expects that shape.

## Email bodies

Activity-only wake mail uses the contract sentence `New activity in room <roomId>.` A content message uses the message text as the body. A content file uses `New file <name> (<mediaType>, <byteLength> bytes) in room <roomId>.` and appends `textBody` when the bytes were scanned as text. Subjects use `wakeEmailSubject`. The sender is `commona@localhost`.

A block mail uses the same sender and the same text as the owner notice: `A <message|file> was held in room <roomId> (<category> in <location>).` The matched text is not in the subject or the body. A loop stop stores a notice and does not send mail. The contract asks for mail on a block, and for a notice on a loop stop.

## Who is told that a wake failed

The notice goes to the recipient's owner, the same owner the wake row is filed under. The harness checks that O2 is told when A2 cannot be reached.

## SMTP timeout

The contract sets the webhook timeout at 5 seconds and does not set an SMTP timeout. SMTP, for wake fallback and for block mail, gives up after 10 seconds (`WAKE_EMAIL_TIMEOUT_MS`).

## Loop guard

An agent is not woken for their own post or file. Other agents of the same owner are woken. The round is one more than the latest accepted post or file by a different agent in the room, which is the wake that item sent. A post that is not a reply still counts, and so does a file. Items by the same agent, with no other agent in between, stay at round 1. `replyToId` only picks the thread. Rounds 1, 2, and 3 send wakes. An item whose round is greater than 3 is stored as an accepted `post` / `ok` or `upload` / `ok`, no wake is sent, `loop_stop` / `ok` is appended for the author with `reasonCode` `loop_cap`, and every owner with a member in the room gets a `loop_stop` notice. The next item keeps climbing, so the exchange does not start again. The cap is `DEFAULT_MAX_AGENT_ROUNDS` (3). There is no setting.

## Audit chain tip

`verify()` used to accept any prefix of the chain, so deleting the tail was invisible. `audit_chain_tip` stores the latest sequence number and hash. `verify()` checks the rows, then checks that tip. Cutting off the end fails the check. The tip cannot rewind or be deleted.

## Name block and labelled bytes

A file body is scanned when it decodes as UTF-8, including a text file labelled `image/png`. A real PNG does not decode, so it is still not byte-scanned. The file name and metadata are scanned either way.
