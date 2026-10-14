import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  GENESIS_PREV_HASH,
  ReasonCode,
  computeAuditHash,
  l1Matches,
  verifyAuditChain,
} from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { openDatabase } from "../../src/db.js";

const ts = "2026-01-02T03:04:05.006Z";

function openLog() {
  const db = openDatabase(":memory:");
  const log = createAuditLog(db, { now: () => new Date(ts) });
  return { db, log };
}

describe("L1 log format", () => {
  it("seals a single chain from 64 zero hex digits and matches the L1 multiset", () => {
    const { db, log } = openLog();
    const first = log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });
    const second = log.append({
      ts,
      room: "room_1",
      agentId: "A2",
      ownerId: "O2",
      action: AuditAction.Read,
      result: AuditResult.Ok,
      detail: { reasonCode: ReasonCode.NotMember },
    });

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(first.prevHash).toBe("0".repeat(64));
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).toBe(computeAuditHash(first.prevHash, first));
    expect(second.hash).toBe(computeAuditHash(second.prevHash, second));
    expect(second.detail).toEqual({ reasonCode: ReasonCode.NotMember });
    expect(log.verify()).toEqual({ ok: true });

    const chain = [first, second];
    expect(verifyAuditChain(chain)).toEqual({ ok: true });
    expect(
      l1Matches(
        [
          { action: AuditAction.Post, agentId: "A1", ownerId: "O1", result: AuditResult.Ok },
          { action: AuditAction.Read, agentId: "A2", ownerId: "O2", result: AuditResult.Ok },
        ],
        chain,
      ),
    ).toBe(true);
    expect(l1Matches([], chain)).toBe(false);

    const stored = db.prepare("SELECT detail_json FROM audit_log WHERE seq = 2").get() as { detail_json: string };
    expect(stored.detail_json).toBe('{"reasonCode":"not_member"}');
    db.close();
  });

  it("rejects a detail key outside the closed schema and writes nothing", () => {
    const { db, log } = openLog();
    expect(() =>
      log.append({
        ts,
        room: "room_1",
        agentId: "A1",
        ownerId: "O1",
        action: AuditAction.Post,
        result: AuditResult.Ok,
        detail: { text: "must not be stored" } as never,
      }),
    ).toThrow(/not allowed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    expect(log.verify()).toEqual({ ok: true });
    db.close();
  });

  it("reports the index of a row whose hash does not match the chain", () => {
    const { db, log } = openLog();
    const first = log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });
    db.prepare(
      `INSERT INTO audit_log (seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash)
       VALUES (2, 'log_tamper', ?, 'room_1', 'A1', 'O1', 'post', 'ok', '{}', ?, ?)`,
    ).run(ts, first.hash, "f".repeat(64));
    expect(log.verify()).toEqual({ ok: false, brokenIndex: 1, seq: 2 });
    db.close();
  });
});
