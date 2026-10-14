import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { send, startRoom } from "./server.js";

describe("membership", () => {
  it("returns an agent token once, then 200 without a new token", async () => {
    const room = await startRoom();
    try {
      const owner = room.tokens.issueOwnerToken("O1");
      const created = await send(room.baseUrl, "POST", "/rooms", owner, {});
      const roomId = (created.body as { room: { id: string } }).room.id;
      const joined = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, owner, { agentId: "A1" });
      expect(joined.status).toBe(201);
      const token = (joined.body as { token: string }).token;
      const repeat = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, owner, { agentId: "A1" });
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual({
        member: expect.objectContaining({ roomId, agentId: "A1", ownerId: "O1" }),
      });
      expect(room.tokens.authenticate(token)).toEqual({ kind: "agent", ownerId: "O1", agentId: "A1" });

      const other = await send(room.baseUrl, "POST", "/rooms", owner, {});
      const otherId = (other.body as { room: { id: string } }).room.id;
      const again = await send(room.baseUrl, "POST", `/rooms/${otherId}/members`, owner, { agentId: "A1" });
      expect(again.status).toBe(201);
      expect(again.body).not.toHaveProperty("token");

      const alone = room.db.prepare("SELECT COUNT(*) AS n FROM sharing WHERE room_id = ?").get(roomId) as { n: number };
      expect(alone.n).toBe(0);
      const ownerTwo = room.tokens.issueOwnerToken("O2");
      const partner = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
      expect(partner.status).toBe(201);
      const pairs = room.db
        .prepare("SELECT from_owner_id, to_owner_id, level FROM sharing WHERE room_id = ? ORDER BY from_owner_id, to_owner_id")
        .all(roomId) as { from_owner_id: string; to_owner_id: string; level: string }[];
      expect(pairs).toEqual([
        { from_owner_id: "O1", to_owner_id: "O2", level: "none" },
        { from_owner_id: "O2", to_owner_id: "O1", level: "none" },
      ]);

      const stored = room.db.prepare("SELECT token_hash FROM agents WHERE id = 'A1'").get() as { token_hash: string };
      expect(stored.token_hash).toBe(hashToken(token));
    } finally {
      await room.stop();
    }
  });

  it("refuses an owner adding someone else's agent and an agent creating a room", async () => {
    const room = await startRoom();
    try {
      const ownerTwo = room.tokens.issueOwnerToken("O2");
      const agent = room.tokens.issueAgentToken("A1");
      const created = await send(room.baseUrl, "POST", "/rooms", agent, {});
      expect(created.status).toBe(403);
      const ownerOne = room.tokens.issueOwnerToken("O1");
      const roomResponse = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
      const roomId = (roomResponse.body as { room: { id: string } }).room.id;
      const refused = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A1" });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { reason: "not_owner" } });
      const rows = room.audit.all().filter((row) => row.action === "join_refused");
      expect(rows.map((row) => row.agentId)).toEqual(["A1", "owner:O2"]);
      expect(rows.map((row) => row.ownerId)).toEqual(["O1", "O2"]);
    } finally {
      await room.stop();
    }
  });

  it("does not audit a missing or malformed token", async () => {
    const room = await startRoom();
    try {
      const text = loadFixtures().normalMessages[2] ?? "";
      const missing = await send(room.baseUrl, "POST", "/rooms");
      const unknown = await send(room.baseUrl, "POST", "/rooms", "not-a-real-token", {});
      expect(missing.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(missing.body).toEqual({ error: { code: "unauthorized", message: "Missing or invalid token." } });

      const owner = room.tokens.issueOwnerToken("O1");
      const created = await send(room.baseUrl, "POST", "/rooms", owner, {});
      const roomId = (created.body as { room: { id: string } }).room.id;
      const joined = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, owner, { agentId: "A1" });
      const token = (joined.body as { token: string }).token;
      const before = room.audit.all().length;
      const bad = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, token, { text: "" });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: { code: "validation", message: "Invalid request." } });
      expect(room.audit.all()).toHaveLength(before);
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await room.stop();
    }
  });
});
