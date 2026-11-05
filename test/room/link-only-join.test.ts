import { afterEach, describe, expect, it } from "vitest";
import { hashToken, UNSCOPED_ROOM } from "../../contract/index.js";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const FORBIDDEN = { error: { code: "forbidden", message: "Not allowed." } };

describe("link-only JSON join", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("joins using only the invite link, returns working keys, and refuses replay on either route", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const path = `/api${invite.openPath}`;
    const opened = await call(room.baseUrl, "GET", path);
    expect(opened.status).toBe(200);
    expect(opened.contentType).toContain("application/json");
    expect(opened.location).toBeNull();
    expect(opened.setCookies).toEqual([]);
    const joined = JSON.parse(opened.body) as { roomId: string; agentId: string; agentKey: string; sharingKey: string };
    expect(joined.roomId).toBe(room.roomId);
    expect(room.tokens.authenticate(joined.agentKey)).toMatchObject({ kind: "agent", agentId: joined.agentId });
    expect(room.tokens.authenticate(joined.sharingKey)).toMatchObject({ kind: "narrow" });
    for (const issued of room.issued.filter((item) => item.kind === "owner")) {
      expect(opened.body).not.toContain(issued.token);
    }
    const secret = invite.openPath.split("/")[3] ?? "";
    expect(opened.body).not.toContain(secret);
    expect(opened.body).not.toContain(hashToken(secret));
    const read = await call(room.baseUrl, "GET", `/api/r/${joined.roomId}`, { token: joined.agentKey });
    expect(read.status).toBe(200);
    for (const replayPath of [path, `/api/r/${joined.roomId}/${invite.id}/${secret}`]) {
      const replay = await call(room.baseUrl, "GET", replayPath);
      expect(replay.status).toBe(403);
      expect(JSON.parse(replay.body)).toEqual(FORBIDDEN);
    }
    expect(refusals(room)).toHaveLength(2);
  });

  it.each(["wrong secret", "expired", "revoked", "unknown", "malformed"])("refuses and audits %s without disclosing a room", async (kind) => {
    room = await startJoinHarness();
    const invite = await createInvite(room, 1);
    let path = `/api${invite.openPath}`;
    if (kind === "wrong secret") path = `/api/j/${invite.id}/fake-wrong-secret`;
    if (kind === "expired") room.clock.advance(1000);
    if (kind === "revoked") {
      room.db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").run(room.clock.now().toISOString(), invite.id);
    }
    if (kind === "unknown") path = "/api/j/inv_00000000-0000-4000-8000-000000000000/fake-secret";
    if (kind === "malformed") path = "/api/j/not-an-invite/fake-secret";
    const refused = await call(room.baseUrl, "GET", path);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(FORBIDDEN);
    expect(refused.body).not.toContain(room.roomId);
    const rows = refusals(room);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.room).toBe(UNSCOPED_ROOM);
    expect(JSON.stringify(rows)).not.toContain(path.split("/").at(-1));
    const stored = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id);
    expect(stored).toEqual({ used_at: null });
  });

  it("does not consume the link on HEAD or POST", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const path = `/api${invite.openPath}`;
    expect((await call(room.baseUrl, "HEAD", path)).status).toBe(200);
    expect((await call(room.baseUrl, "POST", path, { json: {} })).status).toBe(404);
    expect((await call(room.baseUrl, "GET", path)).status).toBe(200);
  });

  it("allows exactly one concurrent join across the new and old routes", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/")[3] ?? "";
    const hits = await Promise.all([
      call(room.baseUrl, "GET", `/api${invite.openPath}`),
      call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}`),
    ]);
    expect(hits.map((hit) => hit.status).sort()).toEqual([200, 403]);
  });

  it("rolls back the join when default sharing fails, then allows retry", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const before = snapshot(room);
    const original = room.db.prepare;
    room.db.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO room_default_post_share")) throw new Error("fake marker failure");
      return original.call(room!.db, sql);
    }) as typeof room.db.prepare;
    try {
      expect((await call(room.baseUrl, "GET", `/api${invite.openPath}`)).status).toBe(500);
    } finally {
      room.db.prepare = original;
    }
    expect(snapshot(room)).toEqual(before);
    expect((await call(room.baseUrl, "GET", `/api${invite.openPath}`)).status).toBe(200);
  });
});

function refusals(room: JoinHarness): { room: string; detail_json: string }[] {
  return room.db.prepare("SELECT room, detail_json FROM audit_log WHERE action = 'join_refused' AND result = 'refused'").all() as { room: string; detail_json: string }[];
}

function snapshot(room: JoinHarness): unknown[] {
  return ["owners", "agents", "memberships", "invites", "sharing", "audit_log", "audit_chain_tip"].map(
    (table) => room.db.prepare(`SELECT * FROM ${table}`).all(),
  );
}
