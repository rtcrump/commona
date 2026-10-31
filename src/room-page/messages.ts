import {
  AuditAction,
  AuditResult,
  feedIncludes,
  formatTimestamp,
  isId,
  type AuthPrincipal,
} from "../../contract/index.js";
import { requireMember } from "../room/access.js";
import type { RoomDeps } from "../room/deps.js";
import type { RoomPagePost } from "./page.js";

export const RECENT_MESSAGE_LIMIT = 20;
/** Stop after this many batches. A page may show fewer than 20 messages. */
export const RECENT_MESSAGE_MAX_BATCHES = 10;

/**
 * Cursor for "nothing yet". A since read with this cursor returns every visible post.
 * Any other cursor is a post id in this room.
 */
export const SINCE_START = "0";

/** A since cursor that is not the start marker and not a post id in this room. */
export class BadReadCursor extends Error {
  constructor() {
    super("That cursor is not valid.");
    this.name = "BadReadCursor";
  }
}

/**
 * One batch of message text, newest first, from an exclusive keyset cursor.
 * No file rows and no file content. Held messages stay out.
 * The cursor is (created_at, id). The index is posts_room_held_recent.
 */
export const RECENT_MESSAGES_SQL = `
SELECT text, author_owner_id, created_at, id
FROM posts
WHERE room_id = ? AND held = 0
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
`;

/**
 * Posts inserted after a cursor, oldest first.
 * `seq` is the SQLite rowid. It only increases when a post is inserted, so a
 * later post cannot fall behind a cursor already issued when it shares that
 * post's millisecond timestamp. No file rows and no file content.
 */
export const NEWER_MESSAGES_SQL = `
SELECT text, author_owner_id, created_at, id, rowid AS seq
FROM posts
WHERE room_id = ? AND held = 0
  AND rowid > ?
ORDER BY rowid ASC
LIMIT ?
`;

/** Past every real post timestamp and id, so the first page batch starts at the newest row. */
const CURSOR_START = "9999-99-99T99:99:99.999Z";

type RecentRow = {
  text: string;
  author_owner_id: string;
  created_at: string;
  id: string;
};

type NewerRow = RecentRow & {
  seq: number;
};

export interface SinceMessage {
  id: string;
  text: string;
}

export interface SincePage {
  posts: SinceMessage[];
  cursor: string;
}

/**
 * Whether this viewer may see one unheld message.
 * This is the room's sharing check. The page and the since read both call it.
 * Do not copy it.
 */
function messageVisible(
  deps: RoomDeps,
  roomId: string,
  principal: AuthPrincipal,
  authorOwnerId: string,
  levels: Map<string, string>,
): boolean {
  let level = levels.get(authorOwnerId);
  if (level === undefined) {
    level = deps.sharing.level(roomId, authorOwnerId, principal.ownerId);
    levels.set(authorOwnerId, level);
  }
  return feedIncludes({
    held: false,
    level,
    itemKind: "message",
    viewerOwnerId: principal.ownerId,
    authorOwnerId,
  });
}

/** Newest messages the viewer may see, oldest of that window first. Also audits the read. */
export function recentMessages(deps: RoomDeps, principal: AuthPrincipal, roomId: string): RoomPagePost[] {
  requireMember(deps, principal, roomId);
  const visible: { text: string }[] = [];
  const levels = new Map<string, string>();
  const stmt = deps.db.prepare(RECENT_MESSAGES_SQL);
  let cursorAt = CURSOR_START;
  let cursorId = CURSOR_START;
  for (let batch = 0; batch < RECENT_MESSAGE_MAX_BATCHES && visible.length < RECENT_MESSAGE_LIMIT; batch += 1) {
    const rows = stmt.all(roomId, cursorAt, cursorId, RECENT_MESSAGE_LIMIT) as RecentRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (visible.length >= RECENT_MESSAGE_LIMIT) break;
      if (messageVisible(deps, roomId, principal, row.author_owner_id, levels)) {
        visible.push({ text: row.text });
      }
    }
    const last = rows[rows.length - 1];
    if (!last) break;
    cursorAt = last.created_at;
    cursorId = last.id;
    if (rows.length < RECENT_MESSAGE_LIMIT) break;
  }
  visible.reverse();
  recordRoomRead(deps, principal, roomId);
  return visible;
}

/**
 * Visible posts newer than `since`, oldest first, and the cursor to use next.
 * `since` is the start marker or a post id in this room. A bad cursor throws.
 * Hidden posts are not returned and do not move the cursor. The scan keeps
 * going through them. The recent page stops after ten batches, and that cap
 * does not apply here: a long hidden run would otherwise leave the cursor in
 * place and hide every later visible post.
 * Does not audit. The route audits once, including when it waited.
 */
export function messagesSince(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  since: string,
): SincePage {
  requireMember(deps, principal, roomId);
  const position = cursorPosition(deps, roomId, since);
  if (position === null) throw new BadReadCursor();
  const visible: SinceMessage[] = [];
  const levels = new Map<string, string>();
  const stmt = deps.db.prepare(NEWER_MESSAGES_SQL);
  let after = position.seq;
  let lastVisibleId = since;
  while (visible.length < RECENT_MESSAGE_LIMIT) {
    const rows = stmt.all(roomId, after, RECENT_MESSAGE_LIMIT) as NewerRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (visible.length >= RECENT_MESSAGE_LIMIT) break;
      if (!messageVisible(deps, roomId, principal, row.author_owner_id, levels)) continue;
      visible.push({ id: row.id, text: row.text });
      lastVisibleId = row.id;
    }
    const last = rows[rows.length - 1];
    if (!last) break;
    const next = Number(last.seq);
    if (!Number.isSafeInteger(next) || next <= after) break;
    after = next;
    if (rows.length < RECENT_MESSAGE_LIMIT) break;
  }
  return { posts: visible, cursor: visible.length > 0 ? lastVisibleId : since };
}

/** One read in the audit log. A wait records this once, not once per poll. */
export function recordRoomRead(deps: RoomDeps, principal: AuthPrincipal, roomId: string): void {
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
}

/** Insert position of a since cursor. The start marker is before every row. */
function cursorPosition(deps: RoomDeps, roomId: string, since: string): { seq: number } | null {
  if (since === SINCE_START) return { seq: 0 };
  if (since.length > 80 || !isId(since)) return null;
  const row = deps.db
    .prepare("SELECT rowid AS seq FROM posts WHERE room_id = ? AND id = ?")
    .get(roomId, since) as { seq: number | bigint } | undefined;
  if (!row) return null;
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { seq };
}
