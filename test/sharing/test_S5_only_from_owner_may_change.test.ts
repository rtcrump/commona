import { describe, expect, it } from "vitest";
import { ReasonCode, SharingLevel } from "../../contract/index.js";
import { ROOM, agent, owner, seedRoom, setupSharing, sharingRows } from "./setup.js";

describe("S5 only the from-owner's owner token may change a row", () => {
  it("refuses agents and other owners, and leaves the feed on the previous grant", () => {
    const { db, sharing, messages } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    const seeded = seedRoom(db, messages);
    const opened = sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.MessagesFiles);
    expect(opened).toEqual({
      allowed: true,
      sharing: { roomId: ROOM, fromOwnerId: "O1", toOwnerId: "O2", level: SharingLevel.MessagesFiles },
    });

    const before = sharingRows(db);
    const agentOwn = sharing.update(agent("O1", "A1"), ROOM, "O1", "O2", SharingLevel.None);
    const agentOther = sharing.update(agent("O2", "A2"), ROOM, "O1", "O2", SharingLevel.None);
    const otherOwner = sharing.update(owner("O2"), ROOM, "O1", "O2", SharingLevel.None);
    expect(agentOwn).toEqual({ allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing });
    expect(agentOther).toEqual({ allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing });
    expect(otherOwner).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });
    expect(sharingRows(db)).toEqual(before);
    expect(sharing.visibleFile(ROOM, seeded.o1FileId, "O2")?.contentBase64).toBeTruthy();

    const reverse = sharing.update(owner("O2"), ROOM, "O2", "O1", SharingLevel.Messages);
    expect(reverse.allowed).toBe(true);
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.MessagesFiles);
    expect(sharing.level(ROOM, "O2", "O1")).toBe(SharingLevel.Messages);

    const auditCount = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(auditCount.n).toBe(0);
    db.close();
  });

  it("treats a malformed pair as an error before it is a refusal", () => {
    const { db, sharing } = setupSharing();
    expect(() => sharing.update(agent("O1", "A1"), ROOM, "O1", "O1", SharingLevel.Messages)).toThrow(
      /two different owners/,
    );
    expect(() => sharing.update(owner("O2"), ROOM, "O1", "O2", "public" as never)).toThrow(/unknown sharing level/);
    expect(sharingRows(db)).toEqual([]);
    db.close();
  });
});
