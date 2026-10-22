import { describe, expect, it } from "vitest";
import { SharingLevel } from "../../contract/index.js";
import {
  HELD_FILE_BODY,
  O1_FILE_BODY,
  O2_FILE_BODY,
  ROOM,
  seedRoom,
  setupSharing,
} from "./setup.js";

describe("S2 None hides the other owner's messages and files", () => {
  it("shows each owner only their own released items, and hides held items", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const seeded = seedRoom(db, messages);

    const o2Feed = sharing.visibleFeed(ROOM, "O2");
    expect(o2Feed.map((item) => item.id)).toEqual([seeded.o2MessageId, seeded.o2FileId]);
    expect(JSON.stringify(o2Feed)).not.toContain(messages[0]);
    expect(JSON.stringify(o2Feed)).not.toContain("o1-note.txt");
    expect(JSON.stringify(o2Feed)).not.toContain(messages[2]);
    expect(JSON.stringify(o2Feed)).not.toContain("held-note.txt");

    const o1Feed = sharing.visibleFeed(ROOM, "O1");
    expect(o1Feed.map((item) => item.id)).toEqual([seeded.o1MessageId, seeded.o1FileId]);

    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O2")).toBeNull();
    expect(sharing.visibleFile(ROOM, seeded.heldFileId, "O2")).toBeNull();
    expect(sharing.visibleFile(ROOM, "file_missing", "O2")).toBeNull();

    const own = sharing.visibleFile(ROOM, seeded.o2FileId, "O2");
    expect(own?.contentBase64).toBe(O2_FILE_BODY.toString("base64"));
    expect(own?.held).toBe(false);

    expect(sharing.level(ROOM, "O2", "O2")).toBe(SharingLevel.None);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O1")?.contentBase64).toBe(
      O1_FILE_BODY.toString("base64"),
    );
    expect(JSON.stringify(sharing.visibleFeed(ROOM, "O1"))).not.toContain(HELD_FILE_BODY.toString("base64"));
    db.close();
  });
});
