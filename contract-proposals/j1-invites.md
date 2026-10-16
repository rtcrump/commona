# J1 contract proposal: invites and accounts from the link

`contract/` is unchanged. This is the shape the invite routes implement, and the additions the contract would need before those types can live beside the room API.

## Routes

| Method and path | Caller | Success |
| --- | --- | --- |
| `POST /rooms/:room/invites` | A member (owner with a member agent, or that agent) | `201` `{ invite: { id, link, expiresAt } }` |
| `DELETE /rooms/:room/invites/:inviteId` | The invite creator or the room creator | `200` `{ revoked: true }` |
| `GET /j/:id` | Anyone with the link | `200` `{ ok: true }` and, on the first visit to an open invite, `Set-Cookie` |
| `POST /j/:id/accept` | The browser that holds the cookie | `201` owner, agent, member, `sharing: "none"`, plus a session cookie |

The link is `https://<host>/j/<invite-id>`. It has no query string. The invite id is a public id (`inv_` plus a UUID). It is not the secret.

The process listens on plain HTTP. A browser stores the `Secure` cookie for a non-local host only on HTTPS, so a non-local link is always `https`, including when the socket itself is HTTP. Loopback (`localhost`, `127.0.0.1`, `::1`) stays `http` when the request is HTTP, which is what `npm start` and the tests use. `COMMONA_PUBLIC_ORIGIN` replaces the request host. It is an origin with no path and no credentials: `https` for any host, or `http` on loopback only. Fastify trusts `X-Forwarded-Proto` from a loopback peer by default (`COMMONA_TRUST_PROXY` can name other proxy addresses, `false`, or `true`). The link is built from the `Host` header, not from `X-Forwarded-Host`.

`POST /j/:id/accept` may send `{ roomId }`. When `roomId` is present and is not the invite's room, the call is refused and the invite stays unused. Omitting `roomId` joins the invite's room.

Default lifetime is 24 hours. `{ expiresInSeconds }` sets it, from 1 second through 30 days. A member who sends a bad lifetime gets `400`. That is a malformed request, not one of the invite refusals.

## Cookie

`GET /j/:id` sets `commona_invite=<secret>; HttpOnly; Secure; SameSite=Strict; Path=/j`.

The secret is 32 random bytes, base64url. The database stores only `SHA-256` (hex), the same hash as bearer tokens. The raw secret is held in process memory until that first GET, then the entry is removed. The M1 server is one process. A restart before the first GET means that link can no longer set the cookie; the member creates a new invite. A multi-process host needs a replacement for that memory hold that is still not a raw column.

`POST /j/:id/accept` reads the cookie. It does not read a secret from the body or the path.

The owner session is `commona_session=<owner token>` with the same `HttpOnly; Secure; SameSite=Strict` flags and `Path=/`. The JSON body has no token. Room routes still authenticate with `Authorization: Bearer`. They do not read this cookie yet.

## Data model

Proposed addition to `SCHEMA_SQL` (applied today by `src/join/migrations/001_invites.sql`):

- `invites` — public id, room, `secret_hash`, creator owner, optional creator agent, expiry, `used_at`, `revoked_at`, `created_at`.
- `owner_agents` — the default agent created for an owner who joined from a link.
- `agent_handoffs` — `secret_hash`, expiry, `used_at`. No raw secret and no raw agent credential.

Redeem, in one immediate transaction:

1. Marks the invite used only when the hash matches, the invite is open, and it has not expired. A second redeem updates zero rows.
2. Inserts the owner (`participant`, `@example.test`), the default agent, and the membership.
3. Calls `SharingDirectory.ensurePair` with each owner already in the room. New pairs stay at None. Existing pairs are not overwritten.
4. Stores the agent credential with `TokenStore.issueAgentToken` and discards the raw value.
5. Appends `join` / `ok`.

## Audit mapping

The audit detail and action lists are closed. Until the contract grows, the invite routes call `AuditLog.append` with the existing actions:

| Event | Action | Result | Detail |
| --- | --- | --- | --- |
| Create | `setting_change` | `ok` | `itemId` = invite id |
| Revoke | `setting_change` | `ok` | `itemId` = invite id |
| Redeem | `join` | `ok` | `itemId` = invite id, filed under the new agent |
| Refusal | `join_refused` | `refused` | Invite id when it is a real id. Non-member create also sets `reasonCode: not_member`. |

Redeem refusals use room `*` and the actor `owner:invite`. They do not name the room or its members. A malformed id is not copied into the row.

Proposed contract additions, so these rows are not sharing changes:

- Actions: `invite_create`, `invite_revoke`, `invite_redeem`, `invite_refused`.
- Reason codes: `invite_expired`, `invite_used`, `invite_revoked`, `invite_mismatch`, `invite_malformed`.
- An `inviteId` detail field, ids only.

`401` (missing or unknown bearer token) is not audited, matching the room routes.

## Handoff

`issueAgentHandoff(deps, ownerId)` returns `{ secret, expiresAt, agentId, ownerId }`. The secret lasts 10 minutes. Issuing another handoff retires an unclaimed one. `claimAgentHandoff(deps, secret)` marks it used and returns a new agent credential from `TokenStore.issueAgentToken`. A second claim, or a claim after 10 minutes, throws `handoff unusable`. Neither value is written to an HTTP response. J3 is the connect step that will call this.

## Refusal body

Expired, reused, revoked, wrong room, malformed id, unknown id, non-member create, and a non-creator revoke all return:

```json
{ "error": { "code": "forbidden", "message": "Not allowed." } }
```

Status `403`. No `reason`. No room id, room name, or member id.

## Threats

| Threat | What refuses it | Test |
| --- | --- | --- |
| Expired link | `expires_at <= now`, generic `403` | `refuses expired, reused, revoked, wrong room, malformed, and non-member with one message` |
| Second redeem | Conditional `UPDATE` inside an immediate transaction | Same test, the replay invite |
| Two concurrent redeems | That same `UPDATE` changes one row | `lets exactly one of two concurrent redeems win` |
| Revoked link | `revoked_at` set by the creator; a member who is not creator or room admin cannot revoke | Same abuse test |
| Invite for room A sent as room B | `{ roomId }` must match; the invite stays unused | Same abuse test, then a correct accept still works |
| Malformed or unknown id | Same `403`, and the bad string is not audited or logged | Same abuse test |
| Non-member create | Membership check, same `403`, audit `not_member` without member names | Same abuse test |
| Secret, credential, handoff, or their hashes rendered | Capturing logger plus a scan of bodies, headers other than the invite `Set-Cookie`, and audit rows | Happy-path test |
| Raw secret in a table | Columns are hashes only; the test dumps every table | Happy-path test and the abuse test |
