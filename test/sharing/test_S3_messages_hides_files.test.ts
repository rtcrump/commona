import { describe, expect, it } from "vitest";
import { SharingLevel } from "../../contract/index.js";
import { O1_FILE_BODY, ROOM, owner, seedRoom, setupSharing } from "./setup.js";

describe("S3 Messages shows messages and hides files", () => {
  it("lets O2 read O1's message and not O1's file, and does not open the reverse", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const seeded = seedRoom(db, messages);
    const updated = sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.Messages);
    expect(updated.allowed).toBe(true);

    const o2Feed = sharing.visibleFeed(ROOM, "O2");
    expect(o2Feed.map((item) => item.id)).toEqual([
      seeded.o1MessageId,
      seeded.o2MessageId,
      seeded.o2FileId,
    ]);
    expect(o2Feed.some((item) => item.kind === "file" && item.id === seeded.o1FileId)).toBe(false);
    expect(JSON.stringify(o2Feed)).not.toContain("o1-note.txt");
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O2")).toBeNull();
    expect(JSON.stringify(sharing.visibleFile(ROOM, seeded.o1FileId, "O2"))).not.toContain(
      O1_FILE_BODY.toString("base64"),
    );

    const o1Feed = sharing.visibleFeed(ROOM, "O1");
    expect(o1Feed.map((item) => item.id)).toEqual([seeded.o1MessageId, seeded.o1FileId]);
    expect(sharing.visibleFile(ROOM, seeded.o2FileId, "O1")).toBeNull();
    db.close();
  });
});
