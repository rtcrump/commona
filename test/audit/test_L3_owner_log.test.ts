import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  ReasonCode,
  hashToken,
  ownerActorId,
} from "../../contract/index.js";
import { AuditForbiddenError, createAuditLog } from "../../src/audit/index.js";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";

const ts = "2026-01-02T03:04:05.006Z";
const clock = { now: () => new Date(ts) };

const tokens = {
  O1: "owner-token-o1",
  O2: "owner-token-o2",
  A1: "agent-token-a1",
  AX: "agent-token-ax",
} as const;

function countRows(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
  return row.n;
}

function seeded() {
  const db = openDatabase(":memory:");
  seedFixtures(db, loadFixtures());
  const setOwner = db.prepare("UPDATE owners SET token_hash = ? WHERE id = ?");
  const setAgent = db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?");
  setOwner.run(hashToken(tokens.O1), "O1");
  setOwner.run(hashToken(tokens.O2), "O2");
  setAgent.run(hashToken(tokens.A1), "A1");
  setAgent.run(hashToken(tokens.AX), "AX");
  const log = createAuditLog(db, clock);
  const app = buildApp({ db, clock });
  return { db, log, app };
}

describe("L3 owner scope", () => {
  it("lists only the requested owner and appends a cross-owner read under the caller", async () => {
    const { db, log, app } = seeded();
    log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });
    log.append({
      ts,
      room: "room_1",
      agentId: "A2",
      ownerId: "O2",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });

    expect(log.listForOwner("O1", "O1").map((row) => row.ownerId)).toEqual(["O1"]);

    expect(() => log.listForOwner("O2", "O1")).toThrow(AuditForbiddenError);
    const callerRows = log.listForOwner("O2", "O2");
    const refusal = callerRows[callerRows.length - 1];
    expect(refusal).toMatchObject({
      room: "*",
      agentId: ownerActorId("O2"),
      ownerId: "O2",
      action: AuditAction.Read,
      result: AuditResult.Refused,
      detail: { reasonCode: ReasonCode.LogOwnerMismatch, targetOwnerId: "O1" },
    });
    expect(log.listForOwner("O1", "O1").map((row) => row.action)).toEqual([AuditAction.Post]);
    expect(log.verify()).toEqual({ ok: true });
    await app.close();
    db.close();
  });

  it("serves GET /log to that owner only and does not audit a bad token or a bad query", async () => {
    const { db, log, app } = seeded();
    log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });
    log.append({
      ts,
      room: "room_1",
      agentId: "A2",
      ownerId: "O2",
      action: AuditAction.Upload,
      result: AuditResult.Ok,
    });

    const own = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: `Bearer ${tokens.O1}` },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { entries: { ownerId: string; action: string }[] };
    expect(ownBody.entries.map((row) => row.ownerId)).toEqual(["O1"]);
    expect(countRows(db)).toBe(2);

    const cross = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: `Bearer ${tokens.O2}` },
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toEqual({
      error: { code: "forbidden", message: "Not allowed.", reason: "log_owner_mismatch" },
    });

    const stillOwn = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: `Bearer ${tokens.O1}` },
    });
    expect(stillOwn.statusCode).toBe(200);
    const stillBody = stillOwn.json() as { entries: { action: string; ownerId: string }[] };
    expect(stillBody.entries).toHaveLength(1);
    expect(stillBody.entries[0]).toMatchObject({ action: "post", ownerId: "O1" });

    const caller = await app.inject({
      method: "GET",
      url: "/log?owner=O2",
      headers: { authorization: `Bearer ${tokens.O2}` },
    });
    expect(caller.statusCode).toBe(200);
    const callerBody = caller.json() as { entries: { action: string; result: string; ownerId: string; detail: unknown }[] };
    expect(callerBody.entries.map((row) => row.ownerId)).toEqual(["O2", "O2"]);
    expect(callerBody.entries[1]).toMatchObject({
      action: "read",
      result: "refused",
      ownerId: "O2",
      agentId: "owner:O2",
      room: "*",
      detail: { reasonCode: "log_owner_mismatch", targetOwnerId: "O1" },
    });

    const beforeUnauth = countRows(db);
    const missing = await app.inject({ method: "GET", url: "/log?owner=O1" });
    const unknown = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/log",
      headers: { authorization: `Bearer ${tokens.O1}` },
    });
    const badOwner = await app.inject({
      method: "GET",
      url: "/log?owner=",
      headers: { authorization: `Bearer ${tokens.O1}` },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid token." } });
    expect(unknown.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: { code: "validation", message: "Invalid request." } });
    expect(badOwner.statusCode).toBe(400);
    expect(countRows(db)).toBe(beforeUnauth);
    expect(log.verify()).toEqual({ ok: true });

    await app.close();
    db.close();
  });

  it("records an agent read as refused under that agent's owner", async () => {
    const { db, log, app } = seeded();
    log.append({
      ts,
      room: "room_1",
      agentId: "A1",
      ownerId: "O1",
      action: AuditAction.Post,
      result: AuditResult.Ok,
    });

    const ownAgent = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: `Bearer ${tokens.A1}` },
    });
    expect(ownAgent.statusCode).toBe(403);
    expect(ownAgent.json()).toEqual({
      error: { code: "forbidden", message: "Not allowed.", reason: "not_owner" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/log?owner=O1",
      headers: { authorization: `Bearer ${tokens.AX}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "forbidden", message: "Not allowed.", reason: "not_owner" },
    });

    const outsider = await app.inject({
      method: "GET",
      url: "/log?owner=O3",
      headers: { authorization: `Bearer ${tokens.AX}` },
    });
    expect(outsider.statusCode).toBe(403);

    const target = log.listForOwner("O1", "O1");
    expect(target.map((row) => ({ action: row.action, agentId: row.agentId, ownerId: row.ownerId }))).toEqual([
      { action: AuditAction.Post, agentId: "A1", ownerId: "O1" },
      { action: AuditAction.Read, agentId: "A1", ownerId: "O1" },
    ]);
    expect(target[1]?.detail).toEqual({ reasonCode: ReasonCode.NotOwner, targetOwnerId: "O1" });
    const filed = log.listForOwner("O3", "O3");
    expect(filed.map((row) => row.detail.reasonCode)).toEqual([ReasonCode.NotOwner, ReasonCode.NotOwner]);
    expect(filed.every((row) => row.agentId === "AX" && row.ownerId === "O3" && row.room === "*")).toBe(true);
    expect(log.verify()).toEqual({ ok: true });

    await app.close();
    db.close();
  });
});
