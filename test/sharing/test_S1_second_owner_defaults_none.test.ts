import { describe, expect, it } from "vitest";
import { ContractError, SharingLevel } from "../../contract/index.js";
import { ROOM, owner, setupSharing, sharingRows } from "./setup.js";

describe("S1 second owner creates both directions at None", () => {
  it("reads a missing pair as None and does not throw", () => {
    const { db, sharing } = setupSharing();
    expect(sharing.level(ROOM, "O1", "O2")).toBe(SharingLevel.None);
    expect(sharing.level(ROOM, "O2", "O1")).toBe(SharingLevel.None);
    expect(sharingRows(db)).toEqual([]);
    db.close();
  });

  it("inserts both directions when the second owner joins, and does not overwrite", () => {
    const { db, sharing } = setupSharing();
    sharing.ensurePair(ROOM, "O1", "O2");
    expect(sharingRows(db)).toEqual([
      { from: "O1", to: "O2", level: SharingLevel.None },
      { from: "O2", to: "O1", level: SharingLevel.None },
    ]);

    const raised = sharing.update(owner("O1"), ROOM, "O1", "O2", SharingLevel.Messages);
    expect(raised.allowed).toBe(true);
    sharing.ensurePair(ROOM, "O2", "O1");
    expect(sharingRows(db)).toEqual([
      { from: "O1", to: "O2", level: SharingLevel.Messages },
      { from: "O2", to: "O1", level: SharingLevel.None },
    ]);
    db.close();
  });

  it("refuses a self pair and an unknown level without writing a row", () => {
    const { db, sharing } = setupSharing();
    expect(() => sharing.ensurePair(ROOM, "O1", "O1")).toThrow(/two different owners/);
    expect(() => sharing.update(owner("O1"), ROOM, "O1", "O1", SharingLevel.Messages)).toThrow(
      /two different owners/,
    );
    expect(() => sharing.update(owner("O1"), ROOM, "O1", "O2", "public" as never)).toThrow(ContractError);
    expect("put" in sharing).toBe(false);
    expect(sharingRows(db)).toEqual([]);
    db.close();
  });
});
