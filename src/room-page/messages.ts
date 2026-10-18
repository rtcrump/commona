import { AuditAction, AuditResult, feedIncludes, formatTimestamp, type AuthPrincipal } from "../../contract/index.js";
import { requireMember } from "../room/access.js";
import type { RoomDeps } from "../room/deps.js";
import type { RoomPagePost } from "./page.js";

export const RECENT_MESSAGE_LIMIT = 20;

/**
 * The 20 newest messages in the room. Message text only.
 * No file rows and no file content. Held messages stay out.
 */
export const RECENT_MESSAGES_SQL = `
SELECT text, author_owner_id
FROM posts
WHERE room_id = ? AND held = 0
ORDER BY created_at DESC, id DESC
LIMIT ?
`;

/** Newest messages the viewer may see, oldest of that window first. Also audits the read. */
export function recentMessages(deps: RoomDeps, principal: AuthPrincipal, roomId: string): RoomPagePost[] {
  requireMember(deps, principal, roomId);
  const rows = deps.db.prepare(RECENT_MESSAGES_SQL).all(roomId, RECENT_MESSAGE_LIMIT) as {
    text: string;
    author_owner_id: string;
  }[];
  const visible: { text: string }[] = [];
  for (const row of rows) {
    const allowed = feedIncludes({
      held: false,
      level: deps.sharing.level(roomId, row.author_owner_id, principal.ownerId),
      itemKind: "message",
      viewerOwnerId: principal.ownerId,
      authorOwnerId: row.author_owner_id,
    });
    if (allowed) visible.push({ text: row.text });
  }
  visible.reverse();
  const actorId = principal.kind === "agent" ? principal.agentId : principal.ownerId;
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: roomId,
    agentId: actorId,
    ownerId: principal.ownerId,
    action: AuditAction.Read,
    result: AuditResult.Ok,
    detail: {},
  });
  return visible;
}
