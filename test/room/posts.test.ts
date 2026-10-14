import { describe, expect, it } from "vitest";
import { BlockCategory, BlockLocation, type ContentGuard } from "../../contract/index.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { send, startRoom } from "./server.js";

const blockAll: ContentGuard = {
  check() {
    return { outcome: "block", hits: [{ category: BlockCategory.Name, location: BlockLocation.Text }] };
  },
};

describe("posts and files", () => {
  it("keeps another owner's message hidden until sharing is opened", async () => {
    const room = await startRoom();
    try {
      const text = loadFixtures().normalMessages[3] ?? "";
      const { roomId, a1, a2 } = await twoMembers(room);
      const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text });
      expect(posted.status).toBe(201);
      const hidden = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed?as=A2`, a2);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toEqual({ items: [] });
      const own = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed`, a1);
      expect(own.status).toBe(200);
      expect((own.body as { items: unknown[] }).items).toHaveLength(1);
    } finally {
      await room.stop();
    }
  });

  it("stores a reply on the parent thread at the next round", async () => {
    const room = await startRoom();
    try {
      const messages = loadFixtures().normalMessages;
      const { roomId, a1, a2 } = await twoMembers(room);
      const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text: messages[4] });
      const postId = (first.body as { post: { id: string } }).post.id;
      const reply = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a2, {
        text: messages[5],
        replyToId: postId,
      });
      expect(reply.status).toBe(201);
      expect((reply.body as { post: { round: number; threadId: string } }).post.round).toBe(2);
      expect((reply.body as { post: { threadId: string } }).post.threadId).toBe(
        (first.body as { post: { threadId: string } }).post.threadId,
      );
      const missing = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a2, {
        text: messages[6],
        replyToId: "post_missing",
      });
      expect(missing.status).toBe(400);
    } finally {
      await room.stop();
    }
  });

  it("holds a blocked post out of every feed and logs block instead of post", async () => {
    const room = await startRoom({ guard: blockAll });
    try {
      const text = loadFixtures().normalMessages[7] ?? "";
      const { roomId, a1 } = await twoMembers(room);
      const owner = room.tokens.issueOwnerToken("O1");
      const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text });
      expect(posted.status).toBe(200);
      expect(posted.body).toMatchObject({
        outcome: "held",
        block: { category: "name", location: "text" },
      });
      const feed = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed?as=A1`, a1);
      expect((feed.body as { items: unknown[] }).items).toEqual([]);
      const held = await send(room.baseUrl, "GET", `/rooms/${roomId}/held`, owner);
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ items: [{ kind: "message", text }] });
      const actions = room.audit.all().map((row) => row.action);
      expect(actions).toContain("block");
      expect(actions).not.toContain("post");
      expect(room.wakes.calls).toEqual([]);
    } finally {
      await room.stop();
    }
  });

  it("returns 404 for a file the other owner cannot see, and does not audit that miss", async () => {
    const room = await startRoom();
    try {
      const { roomId, a1, a2 } = await twoMembers(room);
      const uploaded = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, a1, {
        filename: "note.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("hello").toString("base64"),
      });
      expect(uploaded.status).toBe(201);
      const fileId = (uploaded.body as { file: { id: string } }).file.id;
      const before = room.audit.all().length;
      const hidden = await send(room.baseUrl, "GET", `/rooms/${roomId}/files/${fileId}`, a2);
      expect(hidden.status).toBe(404);
      expect(room.audit.all()).toHaveLength(before);
      const own = await send(room.baseUrl, "GET", `/rooms/${roomId}/files/${fileId}`, a1);
      expect(own.status).toBe(200);
      expect((own.body as { contentBase64: string }).contentBase64).toBe(Buffer.from("hello").toString("base64"));
    } finally {
      await room.stop();
    }
  });

  it("rejects an oversized file and a feed as the wrong agent", async () => {
    const room = await startRoom();
    try {
      const { roomId, a1 } = await twoMembers(room);
      const { MAX_FILE_BYTES } = await import("../../contract/index.js");
      const tooBig = Buffer.alloc(MAX_FILE_BYTES + 1, 1).toString("base64");
      const uploaded = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, a1, {
        filename: "big.bin",
        mediaType: "application/octet-stream",
        contentBase64: tooBig,
      });
      expect(uploaded.status).toBe(400);
      const mismatch = await send(room.baseUrl, "GET", `/rooms/${roomId}/feed?as=A2`, a1);
      expect(mismatch.status).toBe(403);
      expect(room.audit.all().some((row) => row.action === "read" && row.result === "refused")).toBe(true);
    } finally {
      await room.stop();
    }
  });
});

async function twoMembers(room: Awaited<ReturnType<typeof startRoom>>): Promise<{
  roomId: string;
  a1: string;
  a2: string;
}> {
  const ownerOne = room.tokens.issueOwnerToken("O1");
  const ownerTwo = room.tokens.issueOwnerToken("O2");
  const created = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
  const roomId = (created.body as { room: { id: string } }).room.id;
  const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerOne, { agentId: "A1" });
  const second = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
  return {
    roomId,
    a1: (first.body as { token: string }).token,
    a2: (second.body as { token: string }).token,
  };
}
