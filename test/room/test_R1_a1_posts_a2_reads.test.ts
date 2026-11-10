import { describe, expect, it } from "vitest";
import { loadFixtures } from "../helpers/fixtures.js";
import { openRoomSharing } from "./fakes.js";
import { send, startRoom } from "./server.js";

describe("R1", () => {
  it("test_R1_a1_posts_a2_reads", async () => {
    const room = await startRoom();
    try {
      const text = loadFixtures().normalMessages[0] ?? "";
      const ownerOne = room.tokens.issueOwnerToken("O1");
      const ownerTwo = room.tokens.issueOwnerToken("O2");
      const created = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
      expect(created.status).toBe(201);
      const roomId = roomOf(created.body);

      const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerOne, { agentId: "A1" });
      const second = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const a1 = stringField(record(first.body), "token");
      const a2 = stringField(record(second.body), "token");

      openRoomSharing(room.sharing, roomId, "O1", "O2");
      const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text });
      expect(posted.status).toBe(201);
      expect(record(posted.body).outcome).toBe("accepted");
      expect(record(record(posted.body).post).authorAgentId).toBe("A1");
      expect(record(record(posted.body).post).text).toBe(text);

      const feed = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed?as=A2`, a2);
      expect(feed.status).toBe(200);
      const items = record(feed.body).items as unknown[];
      expect(items).toHaveLength(1);
      expect(record(items[0]).kind).toBe("message");
      expect(record(items[0]).authorAgentId).toBe("A1");
      expect(record(items[0]).text).toBe(text);
      expect(room.wakes.calls).toEqual([
        expect.objectContaining({ authorAgentId: "A1", roomId, itemKind: "message", round: 1 }),
      ]);
    } finally {
      await room.stop();
    }
  });
});

function roomOf(body: unknown): string {
  const room = record(record(body).room);
  if (typeof room.id !== "string") throw new Error("room id missing");
  return room.id;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`missing ${key}`);
  return field;
}
