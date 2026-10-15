import { describe, expect, it } from "vitest";
import { ReasonCode, SharingLevel } from "../../contract/index.js";
import { ROOM, T0, owner, seedRoom, setupSharing } from "./setup.js";

const OTHER_ROOM = "room_2";

describe("sharing fails closed", () => {
  it("reads a stored level outside the three values as None and hides the items", () => {
    const { db, sharing, messages } = setupSharing();
    const seeded = seedRoom(db, messages);
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    expect(sharing.visibleFeed(ROOM, "O2").some((item) => item.id === seeded.o1MessageId)).toBe(true);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE sharing SET level = 'all' WHERE room_id = ? AND from_owner_id = 'O1' AND to_owner_id = 'O2'").run(
      ROOM,
    );
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    const feed = sharing.visibleFeed(ROOM, "O2");
    expect(feed.some((item) => item.id === seeded.o1MessageId)).toBe(false);
    expect(feed.some((item) => item.id === seeded.o1FileId)).toBe(false);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O2")).toBeNull();
    db.close();
  });

  it("refuses a principal that is not an owner, even when the owner id matches", () => {
    const { db, sharing } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const service = { kind: "service", ownerId: "O1" } as unknown as ReturnType<typeof owner>;
    const refused = sharing.update(service, ROOM, "O1", "O2", SharingLevel.Messages);
    expect(refused).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    db.close();
  });

  it("does not apply another room's grant or a look-alike owner id", () => {
    const { db, sharing, messages } = setupSharing();
    const seeded = seedRoom(db, messages);
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    const lookalike = `\u039F2`;
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.MessagesFiles);
    expect(sharing.level(ROOM, "O1", lookalike)).toBe(SharingLevel.None);
    expect(sharing.level(ROOM, "O1", "O2\u200B")).toBe(SharingLevel.None);
    expect(sharing.visibleFeed(ROOM, lookalike).some((item) => item.authorOwnerId === "O1")).toBe(false);

    db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, 'O1')").run(OTHER_ROOM, T0);
    db.prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held, created_at
       ) VALUES ('post_other', ?, 'A1', 'O1', ?, NULL, 'post_other', 1, 0, ?)`,
    ).run(OTHER_ROOM, messages[0] ?? "hello", T0);
    expect(sharing.level(OTHER_ROOM, "O1", "O2")).toBe(SharingLevel.None);
    expect(sharing.visibleFeed(OTHER_ROOM, "O2").some((item) => item.id === "post_other")).toBe(false);
    expect(sharing.visibleFeed(ROOM, "O2").some((item) => item.id === seeded.o1MessageId)).toBe(true);
    db.close();
  });

  it("hides a held flag other than 0, and an empty owner id sees nothing", () => {
    const { db, sharing, messages } = setupSharing();
    const seeded = seedRoom(db, messages);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE posts SET held = 2 WHERE id = ?").run(seeded.o1MessageId);
    expect(sharing.visibleFeed(ROOM, "O1").some((item) => item.id === seeded.o1MessageId)).toBe(false);

    db.prepare(
      "INSERT INTO owners (id, email, display_name, role) VALUES ('', 'empty@example.test', 'Empty', 'participant')",
    ).run();
    db.prepare(
      "INSERT INTO agents (id, owner_id, display_name, email) VALUES ('AE', '', 'Empty Agent', 'ae@example.test')",
    ).run();
    db.prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held, created_at
       ) VALUES ('post_empty', ?, 'AE', '', 'hello empty', NULL, 'post_empty', 1, 0, ?)`,
    ).run(ROOM, T0);
    expect(sharing.visibleFeed(ROOM, "")).toEqual([]);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "")).toBeNull();
    db.close();
  });

  it("hides a file whose metadata cannot be read and still returns the other items", () => {
    const { db, sharing, messages } = setupSharing();
    const seeded = seedRoom(db, messages);
    sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    db.prepare("UPDATE files SET metadata_json = ? WHERE id = ?").run("{", seeded.o1FileId);
    const feed = sharing.visibleFeed(ROOM, "O2");
    expect(feed.some((item) => item.id === seeded.o1MessageId)).toBe(true);
    expect(feed.some((item) => item.id === seeded.o2FileId)).toBe(true);
    expect(feed.some((item) => item.id === seeded.o1FileId)).toBe(false);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O1")).toBeNull();
    expect(sharing.visibleFile(ROOM, seeded.o2FileId, "O2")?.name).toBe("o2-note.txt");
    db.close();
  });
});
