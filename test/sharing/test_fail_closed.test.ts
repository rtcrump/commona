import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ReasonCode, SharingLevel, type AuthPrincipal } from "../../contract/index.js";
import { createSharingDirectory } from "../../src/sharing/index.js";
import { ROOM, T0, agent, owner, seedRoom, setupSharing } from "./setup.js";

/**
 * The schema check rejects a level outside the three names, and a held flag
 * other than 0 or 1. These tests rebuild the table without that check so a
 * bad stored value can be read. The reader still has to fail closed.
 */
function dropChecks(db: SqliteDatabase, table: "sharing" | "posts" | "files"): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`CREATE TABLE ${table}_loose AS SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_loose RENAME TO ${table}`);
  db.pragma("foreign_keys = ON");
}

describe("sharing fails closed", () => {
  it("reads a stored level outside the three names as None and hides the items", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    const seeded = seedRoom(db, messages);
    dropChecks(db, "sharing");
    db.prepare("UPDATE sharing SET level = ? WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?").run(
      "all",
      ROOM,
      "O1",
      "O2",
    );
    const fresh = createSharingDirectory(db);
    expect(fresh.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    const ids = fresh.visibleFeed(ROOM, "O2").map((item) => item.id);
    expect(ids).not.toContain(seeded.o1MessageId);
    expect(ids).not.toContain(seeded.o1FileId);
    expect(ids).toContain(seeded.o2MessageId);
    db.close();
  });

  it("refuses a principal that is not an owner even when the owner id matches", () => {
    const { db, sharing } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const guest = { kind: "guest", ownerId: "O1" } as unknown as AuthPrincipal;
    const asGuest = sharing.update(guest, ROOM, "O1", "O2", SharingLevel.Messages);
    const asAgent = sharing.update(agent("O1", "A1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    expect(asGuest).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });
    expect(asAgent).toEqual({ allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing });
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);

    const lookalike = owner("\u039F1");
    const asLookalike = sharing.update(lookalike, ROOM, "O1", "O2", SharingLevel.Messages);
    expect(asLookalike).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    db.close();
  });

  it("does not apply another room's grant or a look-alike owner id", () => {
    const { db, sharing, messages } = setupSharing();
    const seeded = seedRoom(db, messages);
    const lookalike = "\u039F1";
    db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES (?, ?, ?, 'participant')").run(
      lookalike,
      "look@example.test",
      "Lookalike",
    );
    db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, 'O1')").run("room_2", T0);
    sharing.update(owner("O1"), "room_2", "O1", "O2", SharingLevel.MessagesFiles);
    sharing.update(owner(lookalike), ROOM, lookalike, "O2", SharingLevel.MessagesFiles);

    const ids = sharing.visibleFeed(ROOM, "O2").map((item) => item.id);
    expect(ids).not.toContain(seeded.o1MessageId);
    expect(ids).not.toContain(seeded.o1FileId);
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    expect(sharing.level("room_2", "O1", "O2")).toBe(SharingLevel.MessagesFiles);
    expect(sharing.level(ROOM, lookalike, "O2")).toBe(SharingLevel.MessagesFiles);
    db.close();
  });

  it("hides a held flag other than 0, and an empty owner id sees nothing", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    const seeded = seedRoom(db, messages);
    dropChecks(db, "posts");
    db.prepare("UPDATE posts SET held = 2 WHERE id = ?").run(seeded.o1MessageId);

    db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES ('', 'empty@example.test', 'Empty', 'participant')").run();
    db.prepare(
      "INSERT INTO agents (id, owner_id, display_name, email, webhook_url, event_target) VALUES ('AE', '', 'Empty Agent', 'empty-agent@example.test', NULL, NULL)",
    ).run();
    db.prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held, created_at
       ) VALUES ('post_empty', ?, 'AE', '', 'empty note', NULL, 'post_empty', 1, 0, ?)`,
    ).run(ROOM, T0);

    const fresh = createSharingDirectory(db);
    fresh.update(owner("O1"), ROOM, "O1", "", SharingLevel.MessagesFiles);
    const ids = fresh.visibleFeed(ROOM, "O2").map((item) => item.id);
    expect(ids).not.toContain(seeded.o1MessageId);
    expect(ids).toContain(seeded.o1FileId);
    expect(fresh.visibleFeed(ROOM, "")).toEqual([]);
    expect(fresh.visibleFile(ROOM, seeded.o1FileId, "")).toBeNull();
    expect(fresh.visibleFeed(ROOM, "O1").map((item) => item.id)).not.toContain(seeded.o1MessageId);
    db.close();
  });

  it("hides a file whose metadata cannot be read and still returns the other items", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    const seeded = seedRoom(db, messages);
    db.prepare("UPDATE files SET metadata_json = ? WHERE id = ?").run("not-json", seeded.o1FileId);

    const feed = sharing.visibleFeed(ROOM, "O2");
    const ids = feed.map((item) => item.id);
    expect(ids).toContain(seeded.o1MessageId);
    expect(ids).not.toContain(seeded.o1FileId);
    expect(ids).toContain(seeded.o2MessageId);
    expect(ids).toContain(seeded.o2FileId);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O2")).toBeNull();
    expect(sharing.visibleFile(ROOM, seeded.o2FileId, "O2")?.name).toBe("o2-note.txt");
    db.close();
  });
});
