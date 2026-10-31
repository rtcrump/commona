import type { Database as SqliteDatabase } from "better-sqlite3";
import type { AuthPrincipal } from "../../contract/index.js";
import { openDatabase } from "../../src/db.js";
import { createSharingDirectory, type SharingAccess } from "../../src/sharing/index.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";

export const ROOM = "room_1";
export const T0 = "2026-01-02T03:04:05.006Z";
export const T1 = "2026-01-02T03:04:06.006Z";
export const T2 = "2026-01-02T03:04:07.006Z";
export const T3 = "2026-01-02T03:04:08.006Z";
export const T4 = "2026-01-02T03:04:09.006Z";
export const T5 = "2026-01-02T03:04:10.006Z";
export const T6 = "2026-01-02T03:04:11.006Z";

export const O1_FILE_BODY = Buffer.from("o1-room-note", "utf8");
export const O2_FILE_BODY = Buffer.from("o2-room-note", "utf8");
export const HELD_FILE_BODY = Buffer.from("held-room-note", "utf8");

export function owner(ownerId: string): AuthPrincipal {
  return { kind: "owner", ownerId };
}

export function agent(ownerId: string, agentId: string): AuthPrincipal {
  return { kind: "agent", ownerId, agentId };
}

export function setupSharing(): { db: SqliteDatabase; sharing: SharingAccess; messages: string[] } {
  const db = openDatabase(":memory:");
  const pack = loadFixtures();
  seedFixtures(db, pack);
  db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, 'O1')").run(ROOM, T0);
  return { db, sharing: createSharingDirectory(db), messages: pack.normalMessages };
}

export interface SeededRoom {
  o1MessageId: string;
  o1FileId: string;
  o2MessageId: string;
  o2FileId: string;
  heldMessageId: string;
  heldFileId: string;
}

/** Two owners' messages and files, plus one held message and one held file from O2. */
export function seedRoom(db: SqliteDatabase, messages: readonly string[]): SeededRoom {
  const ids: SeededRoom = {
    o1MessageId: "post_o1",
    o1FileId: "file_o1",
    o2MessageId: "post_o2",
    o2FileId: "file_o2",
    heldMessageId: "post_o2_held",
    heldFileId: "file_o2_held",
  };
  insertPost(db, ids.o1MessageId, "A1", "O1", messages[0] ?? "", T1, 0);
  insertFile(db, ids.o1FileId, "A1", "O1", "o1-note.txt", O1_FILE_BODY, T2, 0);
  insertPost(db, ids.o2MessageId, "A2", "O2", messages[1] ?? "", T3, 0);
  insertFile(db, ids.o2FileId, "A2", "O2", "o2-note.txt", O2_FILE_BODY, T4, 0);
  insertPost(db, ids.heldMessageId, "A2", "O2", messages[2] ?? "", T5, 1);
  insertFile(db, ids.heldFileId, "A2", "O2", "held-note.txt", HELD_FILE_BODY, T6, 1);
  return ids;
}

function insertPost(
  db: SqliteDatabase,
  id: string,
  agentId: string,
  ownerId: string,
  text: string,
  createdAt: string,
  held: number,
): void {
  db.prepare(
    `INSERT INTO posts (
       id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held, created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
  ).run(id, ROOM, agentId, ownerId, text, id, held, createdAt);
}

function insertFile(
  db: SqliteDatabase,
  id: string,
  agentId: string,
  ownerId: string,
  name: string,
  body: Buffer,
  createdAt: string,
  held: number,
): void {
  db.prepare(
    `INSERT INTO files (
       id, room_id, author_agent_id, author_owner_id, name, media_type, content,
       metadata_json, byte_length, held, created_at
     ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, '{}', ?, ?, ?)`,
  ).run(id, ROOM, agentId, ownerId, name, body, body.length, held, createdAt);
}

export function sharingRows(db: SqliteDatabase): Array<{ from: string; to: string; level: string }> {
  return db
    .prepare<[string], { from_owner_id: string; to_owner_id: string; level: string }>(
      `SELECT from_owner_id, to_owner_id, level
       FROM sharing WHERE room_id = ? ORDER BY from_owner_id, to_owner_id`,
    )
    .all(ROOM)
    .map((row) => ({ from: row.from_owner_id, to: row.to_owner_id, level: row.level }));
}
