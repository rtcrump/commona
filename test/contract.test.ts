import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TESTS,
  AuditAction,
  AuditResult,
  DEFAULT_SHARING_LEVEL,
  GENESIS_PREV_HASH,
  NAME_BLOCK_KNOWN_LIMIT,
  SharingLevel,
  activityOnlyText,
  assertAuditAppend,
  assertDetail,
  feedIncludes,
  l1Matches,
  roundForPost,
  sealAuditRecord,
  sharingAllows,
  verifyAuditChain,
  wakeDisclosure,
  wakeSuppressed,
} from "../contract/index.js";
import { openDatabase } from "../src/db.js";

const base = {
  id: "log_1",
  seq: 1,
  ts: "2026-01-02T03:04:05.006Z",
  room: "room_1",
  agentId: "A1",
  ownerId: "O1",
  action: AuditAction.Post,
  result: AuditResult.Ok,
  detail: {},
} as const;

describe("sharing contract", () => {
  it("defaults to None", () => {
    expect(DEFAULT_SHARING_LEVEL).toBe(SharingLevel.None);
    expect(DEFAULT_SHARING_LEVEL).toBe("none");
  });

  it("hides other owners until the level allows the item", () => {
    expect(sharingAllows(SharingLevel.None, "message", "O2", "O1")).toBe(false);
    expect(sharingAllows(SharingLevel.Messages, "message", "O2", "O1")).toBe(true);
    expect(sharingAllows(SharingLevel.Messages, "file", "O2", "O1")).toBe(false);
    expect(sharingAllows(SharingLevel.MessagesFiles, "file", "O2", "O1")).toBe(true);
    expect(sharingAllows(SharingLevel.None, "file", "O1", "O1")).toBe(true);
  });

  it("keeps held items out of the feed and sends activity-only wakes at None", () => {
    expect(
      feedIncludes({
        held: true,
        level: SharingLevel.MessagesFiles,
        itemKind: "message",
        viewerOwnerId: "O1",
        authorOwnerId: "O1",
      }),
    ).toBe(false);
    expect(
      wakeDisclosure({
        level: SharingLevel.None,
        itemKind: "message",
        recipientOwnerId: "O2",
        authorOwnerId: "O1",
      }),
    ).toBe("activity_only");
    expect(activityOnlyText("room_1")).toBe("New activity in room room_1.");
  });
});

describe("audit contract", () => {
  it("rejects an entry that has no time", () => {
    expect(() => assertAuditAppend({ ...base, ts: "" })).toThrow(/time/);
  });

  it("rejects detail that could carry blocked text", () => {
    expect(() => assertDetail({ text: "hidden" } as never)).toThrow(/not allowed/);
  });

  it("seals a chain and reports the tampered index", () => {
    const first = sealAuditRecord(GENESIS_PREV_HASH, base);
    const second = sealAuditRecord(first.hash, {
      ...base,
      id: "log_2",
      seq: 2,
      action: AuditAction.Read,
    });
    expect(verifyAuditChain([first, second])).toEqual({ ok: true });
    const tampered = { ...second, result: AuditResult.Refused };
    expect(verifyAuditChain([first, tampered])).toEqual({ ok: false, brokenIndex: 1, seq: 2 });
  });

  it("matches the L1 multiset and refuses an extra row", () => {
    const row = sealAuditRecord(GENESIS_PREV_HASH, base);
    expect(l1Matches([{ action: base.action, agentId: "A1", ownerId: "O1", result: base.result }], [row])).toBe(
      true,
    );
    expect(l1Matches([], [row])).toBe(false);
  });
});

describe("loop contract", () => {
  it("wakes rounds 1 through 3 and stops after that", () => {
    expect(roundForPost({ authorKind: "agent", parentRound: null })).toBe(1);
    expect(roundForPost({ authorKind: "agent", parentRound: 3 })).toBe(4);
    expect(wakeSuppressed(3)).toBe(false);
    expect(wakeSuppressed(4)).toBe(true);
    expect(roundForPost({ authorKind: "owner", parentRound: 4 })).toBe(1);
  });
});

describe("schema", () => {
  it("stores sharing as None when the level is omitted, and refuses audit edits", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES ('O1', 'o1@example.test', 'Owner One', 'participant')").run();
    db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES ('O2', 'o2@example.test', 'Owner Two', 'participant')").run();
    db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES ('room_1', '2026-01-02T03:04:05.006Z', 'O1')").run();
    db.prepare("INSERT INTO sharing (room_id, from_owner_id, to_owner_id) VALUES ('room_1', 'O1', 'O2')").run();
    const level = db.prepare("SELECT level FROM sharing").get() as { level: string };
    expect(level.level).toBe("none");
    expect(() =>
      db.prepare("INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level) VALUES ('room_1', 'O2', 'O1', 'public')").run(),
    ).toThrow(/CHECK/);

    db.prepare(
      `INSERT INTO audit_log (seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash)
       VALUES (1, 'log_1', '2026-01-02T03:04:05.006Z', '*', 'owner:O1', 'O1', 'read', 'ok', '{}', ?, 'abc')`,
    ).run("0".repeat(64));
    expect(() => db.prepare("UPDATE audit_log SET result = 'refused' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log WHERE seq = 1").run()).toThrow(/append-only/);
    db.close();
  });
});

describe("acceptance catalogue", () => {
  it("lists the 19 tests and states the name-block limit", () => {
    expect(ACCEPTANCE_TESTS).toHaveLength(19);
    expect(new Set(ACCEPTANCE_TESTS.map((test) => test.id)).size).toBe(19);
    expect(NAME_BLOCK_KNOWN_LIMIT).toMatch(/Misspellings/);
  });
});
