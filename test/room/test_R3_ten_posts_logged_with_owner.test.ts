import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult } from "../../contract/index.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { send, startRoom } from "./server.js";

describe("R3", () => {
  it("test_R3_ten_posts_logged_with_owner", async () => {
    const room = await startRoom();
    try {
      const messages = loadFixtures().normalMessages.slice(0, 10);
      const ownerOne = room.tokens.issueOwnerToken("O1");
      const ownerTwo = room.tokens.issueOwnerToken("O2");
      const created = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
      const roomId = (created.body as { room: { id: string } }).room.id;
      const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerOne, { agentId: "A1" });
      const second = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
      const a1 = (first.body as { token: string }).token;
      const a2 = (second.body as { token: string }).token;

      for (let index = 0; index < messages.length; index += 1) {
        const token = index % 2 === 0 ? a1 : a2;
        const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, token, { text: messages[index] });
        expect(posted.status).toBe(201);
      }

      const posts = room.audit.all().filter((row) => row.action === AuditAction.Post);
      expect(posts).toHaveLength(10);
      expect(posts.map((row) => row.result)).toEqual(Array.from({ length: 10 }, () => AuditResult.Ok));
      expect(posts.map((row) => [row.agentId, row.ownerId])).toEqual([
        ["A1", "O1"],
        ["A2", "O2"],
        ["A1", "O1"],
        ["A2", "O2"],
        ["A1", "O1"],
        ["A2", "O2"],
        ["A1", "O1"],
        ["A2", "O2"],
        ["A1", "O1"],
        ["A2", "O2"],
      ]);
      expect(room.audit.verify()).toEqual({ ok: true });
    } finally {
      await room.stop();
    }
  });
});
