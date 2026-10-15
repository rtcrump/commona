import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult, BlockCategory, BlockLocation, NoticeKind, ReasonCode, blockNoticeMessage, type ContentGuard } from "../../contract/index.js";
import { guard } from "../../src/guard/index.js";
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
      const refused = await send(room.baseUrl, "GET", `/rooms/${roomId}/held`, owner);
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain(text);
      const held = await send(room.baseUrl, "GET", `/rooms/${roomId}/held`, a1);
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ items: [{ kind: "message", text }] });
      const actions = room.audit.all().map((row) => row.action);
      expect(actions).toContain("block");
      expect(actions).not.toContain("post");
      expect(room.wakes.calls).toEqual([]);
      const notices = room.db
        .prepare("SELECT owner_id, kind, category, location, message FROM notices")
        .all() as { owner_id: string; kind: string; category: string; location: string; message: string }[];
      const told = blockNoticeMessage({
        roomId,
        kind: "message",
        category: BlockCategory.Name,
        location: BlockLocation.Text,
      });
      expect(notices).toEqual([{ owner_id: "O1", kind: "block", category: "name", location: "text", message: told }]);
      expect(told).not.toContain(text);
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

  it("stops waking after 3 rounds and tells every owner in the room", async () => {
    const room = await startRoom();
    try {
      const messages = loadFixtures().normalMessages;
      const { roomId, a1, a2 } = await twoMembers(room);
      const rounds: string[] = [];
      let replyToId: string | undefined;
      for (let i = 0; i < 4; i++) {
        const token = i % 2 === 0 ? a1 : a2;
        const body: { text: string; replyToId?: string } = { text: messages[i] ?? "" };
        if (replyToId) body.replyToId = replyToId;
        const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, token, body);
        expect(posted.status).toBe(201);
        const post = (posted.body as { post: { id: string; round: number } }).post;
        expect(post.round).toBe(i + 1);
        rounds.push(post.id);
        replyToId = post.id;
      }
      expect(room.wakes.calls.map((call) => call.round)).toEqual([1, 2, 3]);
      const stops = room.audit.all().filter((row) => row.action === AuditAction.LoopStop);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({
        agentId: "A2",
        ownerId: "O2",
        result: AuditResult.Ok,
        detail: { reasonCode: ReasonCode.LoopCap, round: 4, itemId: rounds[3] },
      });
      const notices = room.db
        .prepare("SELECT owner_id, kind FROM notices WHERE room_id = ? ORDER BY owner_id")
        .all(roomId) as { owner_id: string; kind: string }[];
      expect(notices).toEqual([
        { owner_id: "O1", kind: NoticeKind.LoopStop },
        { owner_id: "O2", kind: NoticeKind.LoopStop },
      ]);
    } finally {
      await room.stop();
    }
  });

  it("stops waking when two agents trade fresh posts that are not replies", async () => {
    const room = await startRoom();
    try {
      const messages = loadFixtures().normalMessages;
      const { roomId, a1, a2 } = await twoMembers(room);
      const rounds: number[] = [];
      for (let i = 0; i < 5; i++) {
        const token = i % 2 === 0 ? a1 : a2;
        const posted = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, token, {
          text: messages[i] ?? "",
        });
        expect(posted.status).toBe(201);
        const post = (posted.body as { post: { round: number; replyToId: string | null } }).post;
        expect(post.replyToId).toBeNull();
        rounds.push(post.round);
      }
      expect(rounds).toEqual([1, 2, 3, 4, 5]);
      expect(room.wakes.calls.map((call) => call.round)).toEqual([1, 2, 3]);
      const stops = room.audit.all().filter((row) => row.action === AuditAction.LoopStop);
      expect(stops.map((row) => row.agentId)).toEqual(["A2", "A1"]);
    } finally {
      await room.stop();
    }
  });

  it("stops waking when two agents trade files", async () => {
    const room = await startRoom();
    try {
      const { roomId, a1, a2 } = await twoMembers(room);
      const contentBase64 = Buffer.from("hello").toString("base64");
      for (let i = 0; i < 5; i++) {
        const token = i % 2 === 0 ? a1 : a2;
        const uploaded = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, token, {
          filename: `note-${i}.txt`,
          mediaType: "text/plain",
          contentBase64,
        });
        expect(uploaded.status).toBe(201);
        expect(uploaded.body).toMatchObject({ outcome: "accepted" });
      }
      expect(room.wakes.calls.map((call) => call.round)).toEqual([1, 2, 3]);
      expect(room.wakes.calls.map((call) => call.itemKind)).toEqual(["file", "file", "file"]);
      const stops = room.audit.all().filter((row) => row.action === AuditAction.LoopStop);
      expect(stops.map((row) => row.agentId)).toEqual(["A2", "A1"]);
      expect(stops.map((row) => row.detail)).toMatchObject([
        { reasonCode: ReasonCode.LoopCap, round: 4, itemKind: "file" },
        { reasonCode: ReasonCode.LoopCap, round: 5, itemKind: "file" },
      ]);
    } finally {
      await room.stop();
    }
  });

  it("continues the round across a post and a file from the other agent", async () => {
    const room = await startRoom();
    try {
      const messages = loadFixtures().normalMessages;
      const { roomId, a1, a2 } = await twoMembers(room);
      const contentBase64 = Buffer.from("hello").toString("base64");
      const post = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text: messages[0] });
      expect((post.body as { post: { round: number } }).post.round).toBe(1);
      const file = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, a2, {
        filename: "note.txt",
        mediaType: "text/plain",
        contentBase64,
      });
      expect(file.status).toBe(201);
      const again = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, a1, { text: messages[1] });
      expect((again.body as { post: { round: number } }).post.round).toBe(3);
      expect(room.wakes.calls.map((call) => [call.itemKind, call.round])).toEqual([
        ["message", 1],
        ["file", 2],
        ["message", 3],
      ]);
    } finally {
      await room.stop();
    }
  });

  it("holds a text file labelled as an image when the bytes name a listed person", async () => {
    const room = await startRoom({ guard });
    try {
      const { roomId, a1 } = await twoMembers(room);
      const named = Buffer.from("Jane Testpatient", "utf8").toString("base64");
      const labelled = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, a1, {
        filename: "figure.png",
        mediaType: "image/png",
        contentBase64: named,
      });
      expect(labelled.status).toBe(200);
      expect(labelled.body).toMatchObject({
        outcome: "held",
        block: { category: "name", location: "file_body" },
      });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
      const binary = await send(room.baseUrl, "POST", `/rooms/${roomId}/files`, a1, {
        filename: "photo.png",
        mediaType: "image/png",
        contentBase64: png,
      });
      expect(binary.status).toBe(201);
      expect(binary.body).toMatchObject({ outcome: "accepted" });
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
