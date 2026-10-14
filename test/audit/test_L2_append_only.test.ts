import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult, GENESIS_PREV_HASH } from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { openDatabase } from "../../src/db.js";

const ts = "2026-01-02T03:04:05.006Z";

describe("L2 append-only", () => {
  it("rejects update and delete, and the next append still links to the original hash", () => {
    const db = openDatabase(":memory:");
    const log = createAuditLog(db);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log' ORDER BY name")
      .all() as { name: string }[];
    expect(triggers.map((row) => row.name)).toEqual(["audit_log_no_delete", "audit_log_no_update"]);

    const row = log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });
    expect(row.prevHash).toBe(GENESIS_PREV_HASH);

    expect(() => db.prepare("UPDATE audit_log SET result = 'refused' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log WHERE seq = 1").run()).toThrow(/append-only/);

    const stored = db.prepare("SELECT result, hash, prev_hash FROM audit_log WHERE seq = 1").get() as {
      result: string;
      hash: string;
      prev_hash: string;
    };
    expect(stored).toEqual({ result: "ok", hash: row.hash, prev_hash: GENESIS_PREV_HASH });
    expect(log.verify()).toEqual({ ok: true });

    const next = log.append({
      ts,
      room: "room_1",
      agentId: "A2",
      ownerId: "O2",
      action: AuditAction.Join,
      result: AuditResult.Ok,
    });
    expect(next.seq).toBe(2);
    expect(next.prevHash).toBe(row.hash);
    expect(log.verify()).toEqual({ ok: true });
    db.close();
  });
});
