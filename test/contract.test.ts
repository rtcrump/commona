import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TESTS,
  AuditAction,
  AuditResult,
  DEFAULT_SHARING_LEVEL,
  GENESIS_PREV_HASH,
  SharingLevel,
  activityOnlyText,
  assertAuditAppend,
  assertDetail,
  assertDistinctSharingOwners,
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
import { signingSecretFor } from "../src/wakeup/secret.js";

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
    expect(sharingAllows(SharingLevel.MessagesFiles, "message", "O2", "O1")).toBe(true);
    expect(sharingAllows(SharingLevel.None, "file", "O1", "O1")).toBe(true);
    expect(sharingAllows("public", "file", "O2", "O1")).toBe(false);
    expect(sharingAllows("public", "message", "O2", "O1")).toBe(false);
    expect(
      feedIncludes({
        held: false,
        level: "public",
        itemKind: "file",
        viewerOwnerId: "O2",
        authorOwnerId: "O1",
      }),
    ).toBe(false);
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

  it("rejects pairing an owner with itself", () => {
    expect(() => assertDistinctSharingOwners("O1", "O1")).toThrow(/two different owners/);
    expect(() => assertDistinctSharingOwners("O1", "O2")).not.toThrow();
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

  it("adds signing-secret columns to a database created before them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "commona-schema-"));
    const file = path.join(dir, "old.sqlite");
    const created = new Database(file);
    created.exec(`
      CREATE TABLE owners (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('participant', 'outsider')),
        token_hash TEXT
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        display_name TEXT NOT NULL,
        email TEXT NOT NULL,
        webhook_url TEXT,
        event_target TEXT,
        token_hash TEXT
      );
      INSERT INTO owners (id, email, display_name, role)
        VALUES ('O1', 'o1@example.test', 'Owner One', 'participant');
      INSERT INTO agents (id, owner_id, display_name, email)
        VALUES ('A1', 'O1', 'Agent One', 'a1@example.test');
    `);
    created.close();

    const db = openDatabase(file);
    try {
      const owner = db
        .prepare(
          "SELECT webhook_signing_secret AS secret, webhook_secret_revealed AS revealed FROM owners WHERE id = 'O1'",
        )
        .get() as { secret: string | null; revealed: number };
      const agent = db
        .prepare(
          "SELECT webhook_signing_secret AS secret, webhook_secret_revealed AS revealed FROM agents WHERE id = 'A1'",
        )
        .get() as { secret: string | null; revealed: number };
      expect(owner).toEqual({ secret: null, revealed: 0 });
      expect(agent).toEqual({ secret: null, revealed: 0 });

      const secret = signingSecretFor(db, "agent", "A1");
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(() => db.prepare("UPDATE agents SET webhook_secret_revealed = 2 WHERE id = 'A1'").run()).toThrow(/CHECK/);
      db.close();

      const again = openDatabase(file);
      try {
        const stored = again.prepare("SELECT webhook_signing_secret AS secret FROM agents WHERE id = 'A1'").get() as {
          secret: string;
        };
        expect(stored.secret).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        again.close();
      }
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("acceptance catalogue", () => {
  it("lists the 19 tests", () => {
    expect(ACCEPTANCE_TESTS).toHaveLength(19);
    expect(new Set(ACCEPTANCE_TESTS.map((test) => test.id)).size).toBe(19);
  });
});
