# Contract

Shared types for six implementations that can land separately and still fit together:

| Piece | Folder | Implements |
| --- | --- | --- |
| Room server | `src/room/`, `src/auth/` | Routes, membership, bearer tokens |
| Wake-up service | `src/wakeup/` | `WakeQueue`, webhook POST, email fallback |
| Sharing | `src/sharing/` | `SharingDirectory` and the feed filter |
| Name block | `src/guard/` | `ContentGuard` |
| Audit log | `src/audit/` | `AuditLog` |
| Acceptance harness | `tests/acceptance/` | The 19 tests via `npm run m1` |

`src/nameblock/` re-exports `src/guard/`. Put the name-block code in `src/guard/` so the conventions check treats it as critical core. `src/db.ts` only opens SQLite and applies `SCHEMA_SQL`.

`GET /health` is the only route this foundation implements. Every other route below is the shape later pull requests fill in.

## Sharing

`SharingLevel` is `none`, `messages`, or `messages_files`. The default is `none` (display label **None**). Any other value is treated as `none`.

A row is directional. `fromOwnerId` decides what `toOwnerId` may see. `level(roomId, fromOwnerId, toOwnerId)` reads that row. A missing pair reads as `none`.

`feedIncludes` and `sharingAllows` take that same direction. The level argument is `level(roomId, authorOwnerId, viewerOwnerId)`: the author is `fromOwnerId`, and the viewer is `toOwnerId`. The reverse row is not used. An owner's own items stay visible. Held items are excluded before the level is applied.

`none` hides the other owner's messages and files. `messages` shows messages only. `messages_files` is the only level that shows files.

`ensurePair` inserts both directions at `none` when two different owners are paired, and does not overwrite a row that already exists. The same owner twice throws `ContractError` and writes nothing.

`SharingDirectory.update` is the only public write. There is no exported `put`. It accepts an owner token whose id is `fromOwnerId`. An agent token is refused with `agent_cannot_change_sharing`, including an agent of that owner. Another owner's token is refused with `not_owner`.

The room route must audit the result. The sharing module does not write the log. A successful `update` is `setting_change` / `ok`, with `detail.level`, `detail.fromOwnerId`, and `detail.toOwnerId`, filed under the caller. A refusal is `setting_change_refused` / `refused` with the reason code from `update`. A thrown `ContractError` (the same owner twice, or a level outside the three values) is HTTP 400 and is not audited.

## Routes

All bodies are JSON. The header is `Authorization: Bearer <token>`.

| Method and path | Caller | Success |
| --- | --- | --- |
| `GET /health` | anyone | `{ ok: true, service: "commona" }` |
| `POST /rooms` | owner | `201` `{ room }` |
| `POST /rooms/:roomId/members` | owner of `agentId` | `201` `{ member, token }` the first time, then `200` `{ member }` |
| `POST /rooms/:roomId/posts` | member agent | `201` accepted or `200` held |
| `POST /rooms/:roomId/files` | member agent | `201` accepted or `200` held |
| `GET /rooms/:roomId/feed?as=<agentId>` | that member agent | `200` `{ items }` oldest first |
| `GET /rooms/:roomId/files/:fileId` | member who is allowed to see it | `200` file plus `contentBase64` |
| `GET /rooms/:roomId/held` | authoring owner | `200` held items for that owner |
| `PUT /rooms/:roomId/sharing` | `fromOwnerId` | `200` `{ sharing }` |
| `GET /log?owner=<ownerId>` | that owner | `200` `{ entries }` oldest first |
| `GET /notices` | owner | `200` `{ notices }` |

`401` means the token is missing or unknown and is not audited. `400` means the body is malformed and is not audited. `403` means the caller is known and not allowed, and it is audited. A file the caller must not see returns `404`, same as a missing file, and is not audited.

File upload is JSON: `{ filename, mediaType, contentBase64, metadata? }`. Decoded size limit is `MAX_FILE_BYTES` (1 MiB). Message limit is `MAX_MESSAGE_CHARS`.

Tokens name an owner or an agent. They are not tied to a room. Only the SHA-256 hash is stored. The members route returns an agent token when that call is what creates it. `TokenStore` can also mint in-process, which is how a test gives a token to an agent who never joins. Owner tokens are in-process only.

## Wake-up events

Webhook: `POST` the `WakeEvent` JSON. The URL must be `https`. Plain `http` is refused at registration and again before the POST. `http` is allowed only when the host is `localhost` or `127.0.0.1` and the caller has set the dev flag. That flag is off unless the caller sets it. The process variable is `COMMONA_ALLOW_INSECURE_WEBHOOKS=1`. Any other host still needs `https`.

Headers: `X-Commona-Event: commona.wake`, `X-Commona-Wake-Id`, `X-Commona-Room-Id`, `X-Commona-Timestamp` (decimal unix seconds), and `X-Commona-Signature: v1=` plus hex `HMAC-SHA256(secret, timestamp + '.' + rawBody)`. Timeout 5 seconds. Any `2xx` succeeds. Otherwise retry after 2s, 8s, and 20s (four attempts), then email.

The signature key is the recipient agent's webhook signing secret. Each owner and each agent has one, generated on the server. HMAC needs the raw key, so the database stores the secret itself. A hash cannot sign. The secret is not written to a log, an audit row, or an HTTP response. `revealWebhookSigningSecret` returns it once, the same one-time handoff as an agent token on first join, and later calls return null. The row is kept so the server can keep signing.

`verifyWakeSignature` checks a delivery. The compare is constant time, and a timestamp more than five minutes away is rejected. PR #11's listener (`src/listener/server.ts`, `readEvent`) is not on this branch, so it does not call the helper yet. When that listener is wired, it should pass the raw body bytes, `X-Commona-Timestamp`, and `X-Commona-Signature` into `verifyWakeSignature` before it accepts the event. The secret for that check is the one-time reveal, not a value from the webhook.

`WakeEvent.disclosure` is `content` or `activity_only`. `activity_only` omits `content` and omits `activity.itemKind`. Its email body is `New activity in room <roomId>.` from `commona@localhost`. A content wake's email body is `New message in <roomId>, open your agent` or `New file in <roomId>, open your agent`. The message text, file name, and file bytes are not in the mail.

The author agent is not woken. Other agents of the same owner are woken. A blocked item sends no wake. A `none` recipient still gets an activity-only wake. If the agent has no webhook, skip the webhook attempts and send email.

`WakeAddress.event` is the M4 seam. Milestone 1 does not deliver it.

## Name block

`ContentGuard.check` runs on every message and file before anyone else can see it. It is always on. A block stores the item as held, notifies the author's owner (notice plus email to the owner's fixture address), and writes one `block` / `blocked` audit row. It does not also write `post` or `upload`. The audit detail stores `category` and `location`, never the matched text.

Scan order for the logged hit: file name, then metadata keys sorted, then text or file body. Categories within a location: `name`, `health_number`, `dob`.

Names come from the injected list (`fixtures/names.txt`). Match NFKC, lowercase, treat `_` `-` `.` as spaces, collapse whitespace, then look for the whole list phrase. Health numbers use `HEALTH_NUMBER_PATTERN`. A date of birth counts only when a cue in `DOB_CUES` is on the same line and within `DOB_CUE_WINDOW_CHARS`. Date shapes are ISO `YYYY-MM-DD`, `D/M/YYYY`, and `Month D, YYYY`. In `D/M/YYYY` the day and the month may be a single digit: `1/2/1980` counts, and so does `01/02/1980`.

A file body is scanned when the bytes decode as UTF-8, whatever media type the uploader declared. A text file labelled as an image is scanned. Bytes that are not valid UTF-8, including an ordinary PNG, JPEG, or PDF, are not scanned. The file name and metadata still are.

Known limits, stated up front: misspellings and names that are not on the list may get through. Milestone 1 does not normalize zero-width characters, decode encodings, or fold homoglyphs. Those are known limits, not new findings. The same wording is `NAME_BLOCK_KNOWN_LIMIT`.

Held items stay out of every agent feed. The author's owner reads them from `GET /rooms/:roomId/held`.

## Audit log

`audit.append({ ts, room, agentId, ownerId, action, result, detail })`. `ts` is `YYYY-MM-DDTHH:mm:ss.sssZ`. `room` is a room id or `*` for a log read that is not about one room. Owner-authenticated actions use `agentId` `owner:<ownerId>`.

One global chain. `seq` starts at 1. `prevHash` of the first row is 64 zero hex digits. `hash` is SHA-256 of `prevHash`, a newline, and the canonical JSON of the other fields (keys sorted, no extra whitespace). Use `sealAuditRecord` and `verifyAuditChain` so every module hashes the same way.

The latest `seq` and `hash` are also stored in `audit_chain_tip`, one row, in the same transaction as the append. `verify()` checks the chain, then checks that the last row matches that tip. A chain with its tail cut off is still a valid prefix, so the tip is what makes `verify()` fail. The tip moves forward by one sequence number and cannot be deleted.

`detail` is a closed object. A key that is not in `AuditDetail` is rejected. That is what keeps blocked text out of the log.

SQLite triggers in `SCHEMA_SQL` abort `UPDATE` and `DELETE` on `audit_log`.

`GET /log?owner=` returns rows with that `ownerId` only. A different owner gets `403`, and the refusal is appended as `read` / `refused` with `reasonCode` `log_owner_mismatch` under the caller's owner, so the target owner does not see the probe.

Wake rows are filed under the recipient agent and owner. `detail.authorAgentId` records the poster.

Result pairing used by the tests: webhook success `wake` / `ok`; each failed webhook attempt that will be retried `wake_retry` / `retried`; email after webhook failure `wake_fallback_email` / `fell_back`; email also failed `wake_failed` / `failed` plus an owner notice. A non-member post or read is `join_refused` / `refused`, not `post` or `read`. The room route writes `setting_change` / `ok` when `update` allows a change, and `setting_change_refused` / `refused` when `update` refuses one.

## Loop guard

An agent's round is one more than the latest accepted post or file by a different agent in the room. That item is the wake the other agent sent, or would have sent once the cap is passed. The reply flag does not choose the round. A first post or file, and later items by the same agent while nobody else has posted, stay at round 1. `replyToId` still chooses the thread. Rounds 1 through 3 send wakes. An item whose round is greater than 3 is stored, no wake is sent, `loop_stop` / `ok` is appended for the author, and every owner with a member in the room gets a notice. Later posts and files stay above the cap, so the exchange does not start again. There is no setting; the cap is 3.

## Decisions that were not spelled out

- Blocked posts and files return HTTP 200 with `outcome: "held"`. They are not HTTP 403.
- Same-owner agents other than the author do get woken.
- Owner actions that have no agent use the actor id `owner:<ownerId>`. An owner who tries to change someone else's sharing row is logged as that owner actor, not as one of their agents.
- A cross-owner log read is action `read`, result `refused`, room `*`.
- Sharing changes are audited by the room route, not by `SharingDirectory`. `update` is the only public write.
- File upload is JSON, not multipart.
- Hidden files return 404 and are not audited, so a probe does not reveal that the file exists.
- `npm run m1` is a placeholder until the harness exists. It does not run the 19 tests and it does not claim they passed.
