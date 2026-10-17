import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult } from "../../contract/index.js";
import { send, startRoom } from "./server.js";

describe("sharing route", () => {
  it("lets fromOwnerId change the row and audits the caller", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne } = await ownersInRoom(room);
      const changed = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({
        sharing: { roomId, fromOwnerId: "O1", toOwnerId: "O2", level: "messages" },
      });
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      const row = room.audit.all().find((entry) => entry.action === AuditAction.SettingChange);
      expect(row).toMatchObject({
        agentId: "owner:O1",
        ownerId: "O1",
        result: AuditResult.Ok,
        detail: { level: "messages", fromOwnerId: "O1", toOwnerId: "O2" },
      });
    } finally {
      await room.stop();
    }
  });

  it("refuses an agent and another owner, and does not audit a bad body", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne, a1, ownerTwo } = await ownersInRoom(room);
      const before = room.audit.all().length;
      const badLevel = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "public",
      });
      const sameOwner = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O1",
        level: "none",
      });
      expect(badLevel.status).toBe(400);
      expect(sameOwner.status).toBe(400);
      expect(room.audit.all()).toHaveLength(before);

      const agent = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, a1, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      });
      const other = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, ownerTwo, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      });
      expect(agent.status).toBe(403);
      expect(agent.body).toMatchObject({ error: { reason: "agent_cannot_change_sharing" } });
      expect(other.status).toBe(403);
      expect(other.body).toMatchObject({ error: { reason: "not_owner" } });
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("none");
      const refused = room.audit.all().filter((entry) => entry.action === AuditAction.SettingChangeRefused);
      expect(refused.map((entry) => [entry.agentId, entry.ownerId, entry.detail.reasonCode])).toEqual([
        ["A1", "O1", "agent_cannot_change_sharing"],
        ["owner:O2", "O2", "not_owner"],
      ]);
    } finally {
      await room.stop();
    }
  });
});

async function ownersInRoom(room: Awaited<ReturnType<typeof startRoom>>): Promise<{
  roomId: string;
  ownerOne: string;
  ownerTwo: string;
  a1: string;
}> {
  const ownerOne = room.tokens.issueOwnerToken("O1");
  const ownerTwo = room.tokens.issueOwnerToken("O2");
  const created = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
  const roomId = (created.body as { room: { id: string } }).room.id;
  const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerOne, { agentId: "A1" });
  await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
  return { roomId, ownerOne, ownerTwo, a1: (first.body as { token: string }).token };
}