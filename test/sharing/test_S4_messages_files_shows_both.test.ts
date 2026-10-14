import { describe, expect, it } from "vitest";
import { SharingLevel } from "../../contract/index.js";
import { O1_FILE_BODY, O2_FILE_BODY, ROOM, owner, seedRoom, setupSharing } from "./setup.js";

describe("S4 Messages + files shows messages and files", () => {
  it("lets O2 read O1's message and file bytes, and still hides the reverse and held items", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const seeded = seedRoom(db, messages);
    const updated = sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    expect(updated.allowed).toBe(true);

    const o2Feed = sharing.visibleFeed(ROOM, "O2");
    expect(o2Feed.map((item) => item.id)).toEqual([
      seeded.o1MessageId,
      seeded.o1FileId,
      seeded.o2MessageId,
      seeded.o2FileId,
    ]);
    const file = o2Feed.find((item) => item.id === seeded.o1FileId);
    expect(file).toMatchObject({ kind: "file", name: "o1-note.txt", byteLength: O1_FILE_BODY.length });

    const download = sharing.visibleFile(ROOM, seeded.o1FileId, "O2");
    expect(download?.contentBase64).toBe(O1_FILE_BODY.toString("base64"));
    expect(download?.authorOwnerId).toBe("O1");

    expect(sharing.visibleFeed(ROOM, "O1").map((item) => item.id)).toEqual([
      seeded.o1MessageId,
      seeded.o1FileId,
    ]);
    expect(sharing.visibleFile(ROOM, seeded.o2FileId, "O1")).toBeNull();
    expect(sharing.visibleFile(ROOM, seeded.heldFileId, "O2")).toBeNull();
    expect(sharing.visibleFile(ROOM, seeded.heldFileId, "O1")).toBeNull();
    expect(JSON.stringify(sharing.visibleFeed(ROOM, "O2"))).not.toContain(O2_FILE_BODY.toString("base64"));
    db.close();
  });
});
