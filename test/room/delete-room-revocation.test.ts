import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { claimAgentHandoff, issueAgentHandoff } from "../../src/onboarding/handoff.js";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const NOTE = "Bring napkins";

describe("room delete keeps the reissue block", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("still blocks a revoked agent who also belongs to another room", async () => {
    room = await startJoinHarness();
    const roomA = room.roomId;
    const joined = await join(room);
    const key = joined.agentKey;
    const agent = room.db.prepare("SELECT id, owner_id FROM agents WHERE id = ?").get(joined.agentId) as {
      id: string;
      owner_id: string;
    };
    const agentOwner = room.tokens.issueOwnerToken(agent.owner_id);

    const createdB = await call(room.baseUrl, "POST", "/rooms", { token: agentOwner, json: {} });
    expect(createdB.status).toBe(201);
    const roomB = (JSON.parse(createdB.body) as { room: { id: string } }).room.id;
    const memberB = await call(room.baseUrl, "POST", `/rooms/${roomB}/members`, {
      token: agentOwner,
      json: { agentId: agent.id },
    });
    expect(memberB.status).toBe(201);
    expect(JSON.parse(memberB.body)).not.toHaveProperty("token");
    const rooms = room.db.prepare("SELECT room_id FROM memberships WHERE agent_id = ?").all(agent.id) as {
      room_id: string;
    }[];
    expect(rooms.map((row) => row.room_id).sort()).toEqual([roomA, roomB].sort());

    const revoked = await call(room.baseUrl, "DELETE", `/api/r/${roomA}/agents/${agent.id}`, {
      token: room.owner,
    });
    expect(revoked.status).toBe(200);
    const before = revocations(room, agent.id);
    expect(before).toEqual([
      { token_hash: hashToken(key), agent_id: agent.id, room_id: roomA, blocks_reissue: 1 },
    ]);

    const handoffDeps = { db: room.db, clock: room.clock, tokens: room.tokens };
    const handoff = issueAgentHandoff(handoffDeps, agent.owner_id);
    const auditBefore = count(room, "SELECT COUNT(*) AS n FROM audit_log");
    const tipBefore = room.db.prepare("SELECT seq, hash FROM audit_chain_tip").get() as { seq: number; hash: string };

    const deleted = await call(room.baseUrl, "DELETE", `/rooms/${roomA}`, { token: room.owner });
    expect(deleted.status).toBe(200);
    const deletedBody = JSON.parse(deleted.body) as {
      deleted?: boolean;
      audit?: { action?: string; result?: string; room?: string; hash?: string };
    };
    expect(deletedBody.deleted).toBe(true);
    expect(deletedBody.audit).toMatchObject({ action: "setting_change", result: "ok", room: roomA });
    expect(deletedBody.audit?.hash).toBe(
      (room.db.prepare("SELECT hash FROM audit_chain_tip").get() as { hash: string }).hash,
    );
    expect(count(room, "SELECT COUNT(*) AS n FROM audit_log")).toBe(auditBefore + 1);
    const tipAfter = room.db.prepare("SELECT seq, hash FROM audit_chain_tip").get() as { seq: number; hash: string };
    expect(tipAfter.seq).toBe(tipBefore.seq + 1);
    expect(revocations(room, agent.id)).toEqual(before);
    expect(room.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomA)).toBeUndefined();
    expect(room.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomB)).toBeDefined();
    expect(count(room, "SELECT COUNT(*) AS n FROM memberships WHERE room_id = ?", roomA)).toBe(0);
    expect(
      room.db.prepare("SELECT agent_id FROM memberships WHERE room_id = ? AND agent_id = ?").get(roomB, agent.id),
    ).toBeDefined();

    const issuedBefore = room.issued.filter((item) => item.kind === "agent").length;
    const intoB = await call(room.baseUrl, "POST", `/rooms/${roomB}/members`, {
      token: agentOwner,
      json: { agentId: agent.id },
    });
    expect(intoB.status).toBe(403);
    expect(JSON.parse(intoB.body)).toEqual({ error: { code: "forbidden", message: "Not allowed." } });

    const createdC = await call(room.baseUrl, "POST", "/rooms", { token: agentOwner, json: {} });
    expect(createdC.status).toBe(201);
    const roomC = (JSON.parse(createdC.body) as { room: { id: string } }).room.id;
    const intoC = await call(room.baseUrl, "POST", `/rooms/${roomC}/members`, {
      token: agentOwner,
      json: { agentId: agent.id },
    });
    expect(intoC.status).toBe(403);
    expect(JSON.parse(intoC.body)).toEqual({ error: { code: "forbidden", message: "Not allowed." } });
    expect(
      room.db.prepare("SELECT agent_id FROM memberships WHERE room_id = ? AND agent_id = ?").get(roomC, agent.id),
    ).toBeUndefined();
    expect(tokenHash(room, agent.id)).toBeNull();
    expect(room.issued.filter((item) => item.kind === "agent")).toHaveLength(issuedBefore);

    expect(() => claimAgentHandoff(handoffDeps, handoff.secret)).toThrow(/unusable/);
    expect(tokenHash(room, agent.id)).toBeNull();
    expect(room.issued.filter((item) => item.kind === "agent")).toHaveLength(issuedBefore);
    const pending = room.db
      .prepare("SELECT used_at FROM agent_handoffs WHERE secret_hash = ?")
      .get(hashToken(handoff.secret)) as { used_at: string | null };
    expect(pending.used_at).toBeNull();
    expect(revocations(room, agent.id)).toEqual(before);

    const read = await call(room.baseUrl, "GET", `/api/r/${roomB}`, { token: key });
    expect(read.status).toBe(401);
    expect(read.body.includes(key)).toBe(false);
    const posted = await call(room.baseUrl, "POST", `/rooms/${roomB}/posts`, {
      token: key,
      json: { text: NOTE },
    });
    expect(posted.status).toBe(401);
    expect(posted.body.includes(key)).toBe(false);
    const feed = await call(room.baseUrl, "GET", `/rooms/${roomB}/feed`, { token: key });
    expect(feed.status).toBe(401);
    expect(feed.body.includes(key)).toBe(false);
  });
});

interface RevocationRow {
  token_hash: string;
  agent_id: string;
  room_id: string;
  blocks_reissue: number;
}

function revocations(room: JoinHarness, agentId: string): RevocationRow[] {
  return room.db
    .prepare(
      "SELECT token_hash, agent_id, room_id, blocks_reissue FROM agent_key_revocations WHERE agent_id = ? ORDER BY token_hash",
    )
    .all(agentId) as RevocationRow[];
}

function tokenHash(room: JoinHarness, agentId: string): string | null {
  const row = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agentId) as {
    token_hash: string | null;
  };
  return row.token_hash;
}

function count(room: JoinHarness, sql: string, ...args: string[]): number {
  const row = room.db.prepare(sql).get(...args) as { n: number };
  return Number(row.n);
}

async function join(room: JoinHarness): Promise<{ agentId: string; agentKey: string }> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}`);
  expect(opened.status).toBe(200);
  const body = JSON.parse(opened.body) as { agentId: string; agentKey: string };
  expect(body.agentKey.includes(secret)).toBe(false);
  return body;
}
