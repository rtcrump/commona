# Stream 2 contract proposal

Not applied. The connector calls the current routes. Held items and notices go out with `COMMONA_OWNER_TOKEN` so an agent token is not sent to a route that would audit a refusal.

## Why

`GET /rooms/:roomId/held` and `GET /notices` require an owner principal. An agent receives 403 `not_owner`, and that refusal is audited (`read` / `refused`). Feed, post, and upload require an agent principal. Join (`POST /rooms/:roomId/members`) requires the owner of that agent.

A personal agent that can post and can also read held items today must hold the owner token. That token can also create rooms and change sharing. The connector keeps it in the server environment and does not put it in tool arguments. A narrower read would let the operator omit the owner token after join.

## Proposed behavior

1. An agent token may `GET /rooms/:roomId/held`. The list stays limited to rows whose `author_owner_id` is that agent's owner. Another owner's held items stay out. A successful read is audited as `read` / `ok` under the agent id and that owner. A non-member is still `join_refused`.
2. An agent token may `GET /notices` and receives the same rows as its owner, oldest first. A successful read stays unaudited, matching a successful owner read. The 403 path for an agent is removed.
3. Do not return held text, file bytes, or the matched name to any other owner. This proposal does not change that.
4. No change to wake delivery. `WakeAddress.event` stays undelivered in milestone 1. The listener is the webhook bridge.

## Sketch (do not apply from this PR)

`src/room/posts.ts`, `readHeld`:

```diff
-  if (principal.kind !== "owner") {
+  const ownerId = principal.ownerId;
+  if (principal.kind === "agent") {
+    requireMember(deps, principal, roomId);
+  } else if (principal.kind !== "owner") {
     refuse(deps, {
       room: roomId,
       principal,
       action: AuditAction.Read,
       reasonCode: "not_owner",
     });
   }
```

The held queries already filter `author_owner_id = principal.ownerId`. Keep that filter. Audit `agentId` as the agent id when the caller is an agent, and as `owner:<ownerId>` when the caller is the owner.

`src/notices/route.ts`:

```diff
-    if (principal.kind !== "owner") {
-      deps.audit.append({
-        ts: formatTimestamp(deps.clock.now()),
-        room: UNSCOPED_ROOM,
-        agentId: principal.agentId,
-        ownerId: principal.ownerId,
-        action: AuditAction.Read,
-        result: AuditResult.Refused,
-        detail: { reasonCode: ReasonCode.NotOwner },
-      });
-      throw RoomHttpError.forbidden(ReasonCode.NotOwner);
-    }
-    return { notices: listNotices(deps.db, principal.ownerId) };
+    return { notices: listNotices(deps.db, principal.ownerId) };
```

`contract/README.md` route table: held and notices callers become "authoring owner, or an agent of that owner".

## Adapter until that lands

`connectors/mcp-server/room.ts` calls held and notices with the owner token only. If `COMMONA_OWNER_TOKEN` is unset, the tool returns an error and does not call the room, so it does not write a refusal row.
