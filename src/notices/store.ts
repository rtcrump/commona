import type Database from "better-sqlite3";
import {
  formatTimestamp,
  newId,
  type Clock,
  type OwnerNotice,
  type OwnerNoticeInput,
  type OwnerNotifier,
} from "../../contract/index.js";

interface NoticeRow {
  id: string;
  owner_id: string;
  room_id: string;
  kind: OwnerNotice["kind"];
  category: OwnerNotice["category"] | null;
  location: OwnerNotice["location"] | null;
  message: string;
  item_id: string | null;
  created_at: string;
}

export function createOwnerNotifier(db: Database.Database, clock: Clock): OwnerNotifier {
  const insert = db.prepare(
    `INSERT INTO notices (
       id, owner_id, room_id, kind, category, location, message, item_id, created_at
     ) VALUES (
       @id, @ownerId, @roomId, @kind, @category, @location, @message, @itemId, @createdAt
     )`,
  );
  return {
    notify(input: OwnerNoticeInput): OwnerNotice {
      const notice: OwnerNotice = {
        id: newId("notice"),
        createdAt: formatTimestamp(clock.now()),
        ownerId: input.ownerId,
        roomId: input.roomId,
        kind: input.kind,
        message: input.message,
      };
      if (input.category !== undefined) notice.category = input.category;
      if (input.location !== undefined) notice.location = input.location;
      if (input.itemId !== undefined) notice.itemId = input.itemId;
      insert.run({
        id: notice.id,
        ownerId: notice.ownerId,
        roomId: notice.roomId,
        kind: notice.kind,
        category: notice.category ?? null,
        location: notice.location ?? null,
        message: notice.message,
        itemId: notice.itemId ?? null,
        createdAt: notice.createdAt,
      });
      return notice;
    },
  };
}

/** Notices for one owner, oldest first. */
export function listNotices(db: Database.Database, ownerId: string): OwnerNotice[] {
  const rows = db
    .prepare(
      `SELECT id, owner_id, room_id, kind, category, location, message, item_id, created_at
       FROM notices
       WHERE owner_id = ?
       ORDER BY created_at, id`,
    )
    .all(ownerId) as NoticeRow[];
  return rows.map(mapNotice);
}

function mapNotice(row: NoticeRow): OwnerNotice {
  const notice: OwnerNotice = {
    id: row.id,
    ownerId: row.owner_id,
    roomId: row.room_id,
    kind: row.kind,
    message: row.message,
    createdAt: row.created_at,
  };
  if (row.category) notice.category = row.category;
  if (row.location) notice.location = row.location;
  if (row.item_id) notice.itemId = row.item_id;
  return notice;
}
