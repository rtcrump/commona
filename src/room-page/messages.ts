import {
  AuditAction,
  AuditResult,
  feedIncludes,
  formatTimestamp,
  type AuthPrincipal,
  type RoomMessagePost,
} from "../../contract/index.js";
import { requireMember } from "../room/access.js";
import type { RoomDeps } from "../room/deps.js";
import { feedPartyLookup } from "../room/feed-author.js";

export const RECENT_MESSAGE_LIMIT = 20;
/** Stop after this many batches. A page may show fewer than 20 messages. */
export const RECENT_MESSAGE_MAX_BATCHES = 10;

/**
 * One batch of message text, newest first, from an exclusive keyset cursor.
 * No file rows and no file content. Held messages stay out.
 * The cursor is (created_at, id). The index is posts_room_held_recent.
 */
export const RECENT_MESSAGES_SQL = `
SELECT text, author_owner_id, author_agent_id, created_at, id
FROM posts
WHERE room_id = ? AND held = 0
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
`;

/** Past every real post timestamp and id, so the first batch starts at the newest row. */
const CURSOR_START = "9999-99-99T99:99:99.999Z";

type RecentRow = {
  text: string;
  author_owner_id: string;
  author_agent_id: string;
  created_at: string;
  id: string;
};

/** Newest messages the viewer may see, oldest of that window first. Also audits the read. */
export function recentMessages(deps: RoomDeps, principal: AuthPrincipal, roomId: string): RoomMessagePost[] {
  requireMember(deps, principal, roomId);
  const visible: RoomMessagePost[] = [];
  const levels = new Map<string, string>();
  const parties = feedPartyLookup(deps.db);
  const stmt = deps.db.prepare(RECENT_MESSAGES_SQL);
  let cursorAt = CURSOR_START;
  let cursorId = CURSOR_START;
  for (let batch = 0; batch < RECENT_MESSAGE_MAX_BATCHES && visible.length < RECENT_MESSAGE_LIMIT; batch += 1) {
    const rows = stmt.all(roomId, cursorAt, cursorId, RECENT_MESSAGE_LIMIT) as RecentRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (visible.length >= RECENT_MESSAGE_LIMIT) break;
      let level = levels.get(row.author_owner_id);
      if (level === undefined) {
        level = deps.sharing.level(roomId, row.author_owner_id, principal.ownerId);
        levels.set(row.author_owner_id, level);
      }
      const allowed = feedIncludes({
        held: false,
        level,
        itemKind: "message",
        viewerOwnerId: principal.ownerId,
        authorOwnerId: row.author_owner_id,
      });
      if (allowed) {
        const named = parties(row.author_agent_id, row.author_owner_id);
        visible.push({ text: row.text, author: named.author, owner: named.owner });
      }
    }
    const last = rows[rows.length - 1];
    if (!last) break;
    cursorAt = last.created_at;
    cursorId = last.id;
    if (rows.length < RECENT_MESSAGE_LIMIT) break;
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
