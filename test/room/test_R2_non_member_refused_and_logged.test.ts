import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult } from "../../contract/index.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { send, startRoom } from "./server.js";

describe("R2", () => {
  it("test_R2_non_member_refused_and_logged", async () => {
    const room = await startRoom();
    try {
      const text = loadFixtures().normalMessages[1] ?? "";
      const owner = room.tokens.issueOwnerToken("O1");
      const outsider = room.tokens.issueAgentToken("AX");
      const created = await send(room.baseUrl, "POST", "/rooms", owner, {});
      const roomId = (created.body as { room: { id: string } }).room.id;

      const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, outsider, { text });
      const feed = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed?as=AX`, outsider);
      expect(posted.status).toBe(403);
      expect(feed.status).toBe(403);
      expect(posted.body).toEqual({
        error: { code: "forbidden", message: "Not allowed.", reason: "not_member" },
      });

      const rows = room.audit.all();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.action)).toEqual([AuditAction.JoinRefused, AuditAction.JoinRefused]);
      expect(rows.every((row) => row.result === AuditResult.Refused)).toBe(true);
      expect(rows.every((row) => row.agentId === "AX" && row.ownerId === "O3")).toBe(true);
      expect(rows.every((row) => row.room === roomId)).toBe(true);
      expect(room.audit.verify()).toEqual({ ok: true });
    } finally {
      await room.stop();
    }
  });
});
