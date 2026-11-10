import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_WAKE_ID,
  WakeState,
} from "../../contract/index.js";
import {
  MESSAGE_TEXT,
  ROOM_ID,
  WHEN,
  enqueueInput,
  expectChain,
  hitsFor,
  insertFile,
  insertMessage,
  setSharing,
  setupRoom,
  stopRoom,
} from "./room.js";

describe("W1 webhook disclosure", () => {
  it("wakes every member except the author, including another agent of the same owner", async () => {
    const room = await setupRoom({ sameOwnerAgent: true });
    try {
      insertMessage(room.db);
      room.webhook.setStatus(204);
      const events = room.service.enqueue(enqueueInput());
      expect(room.service.enqueue(enqueueInput())).toEqual([]);
      expect(events.map((event) => event.recipient.agentId)).toEqual(["A1b", "A2"]);
      expect(events.map((event) => event.type)).toEqual([WAKE_EVENT_TYPE, WAKE_EVENT_TYPE]);
      expect(events.every((event) => event.occurredAt === WHEN && event.round === 1)).toBe(true);
      expect(events.every((event) => event.author.agentId === "A1" && event.roomId === ROOM_ID)).toBe(true);

      const sameOwner = events[0];
      const otherOwner = events[1];
      expect(sameOwner?.disclosure).toBe("content");
      expect(sameOwner?.activity).toEqual({ itemKind: "message" });
      expect(sameOwner?.content).toEqual({
        kind: "message",
        itemId: "post_1",
        text: MESSAGE_TEXT,
        replyToId: null,
        round: 1,
      });
      expect(otherOwner?.disclosure).toBe("activity_only");
      expect(otherOwner?.activity).toEqual({});
      expect(otherOwner).not.toHaveProperty("content");
      expect(JSON.stringify(otherOwner)).not.toContain(MESSAGE_TEXT);
      expect(JSON.stringify(otherOwner)).not.toContain("itemKind");

      const results = await room.service.deliverPending();
      expect(results.map((result) => result.state)).toEqual([WakeState.WebhookSucceeded, WakeState.WebhookSucceeded]);
      expect(results.every((result) => result.attempts === 1)).toBe(true);
      expect(room.sleeps).toEqual([]);
      expect(room.mail.messages).toEqual([]);
      expect(hitsFor(room.webhook.hits, "A1")).toEqual([]);
      expect(hitsFor(room.webhook.hits, "AX")).toEqual([]);
      expect(hitsFor(room.webhook.hits, "A1b")).toHaveLength(1);
      expect(hitsFor(room.webhook.hits, "A2")).toHaveLength(1);

      for (const event of events) {
        const hit = hitsFor(room.webhook.hits, event.recipient.agentId)[0];
        expect(hit?.method).toBe("POST");
        expect(hit?.headers["content-type"]).toBe("application/json");
        expect(hit?.headers[WAKE_HEADER_EVENT.toLowerCase()]).toBe(WAKE_EVENT_TYPE);
        expect(hit?.headers[WAKE_HEADER_WAKE_ID.toLowerCase()]).toBe(event.wakeId);
        expect(hit?.headers[WAKE_HEADER_ROOM_ID.toLowerCase()]).toBe(ROOM_ID);
        expect(hit?.json).toEqual(event);
      }

      const hidden = room.db
        .prepare("SELECT payload_json FROM wakes WHERE recipient_agent_id = 'A2'")
        .get() as { payload_json: string };
      expect(hidden.payload_json).not.toContain(MESSAGE_TEXT);
      expect(hidden.payload_json).not.toContain("itemKind");
      expect(hidden.payload_json).not.toContain('"content"');

      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.agentId, row.ownerId, row.action, row.result, row.detail.attempt])).toEqual([
        ["A1b", "O1", AuditAction.Wake, AuditResult.Ok, 1],
        ["A2", "O2", AuditAction.Wake, AuditResult.Ok, 1],
      ]);
      expect(audit.every((row) => row.detail.authorAgentId === "A1" && row.ts === WHEN && row.room === ROOM_ID)).toBe(
        true,
      );
      expect(room.db.prepare("SELECT COUNT(*) AS n FROM notices").get()).toEqual({ n: 0 });
    } finally {
      await stopRoom(room);
    }
  });

  it("sends message content only when that owner's sharing level allows it", async () => {
    const room = await setupRoom();
    try {
      insertMessage(room.db, { replyToId: null });
      setSharing(room.db, "O2", "O1", "messages_files");
      const hidden = room.service.enqueue(enqueueInput());
      expect(hidden[0]?.disclosure).toBe("activity_only");
      expect(JSON.stringify(hidden[0])).not.toContain(MESSAGE_TEXT);

      room.db.prepare("DELETE FROM wakes").run();
      setSharing(room.db, "O1", "O2", "messages");
      const shown = room.service.enqueue(enqueueInput());
      expect(shown).toHaveLength(1);
      expect(shown[0]?.disclosure).toBe("content");
      expect(shown[0]?.content).toMatchObject({ kind: "message", text: MESSAGE_TEXT });
      await room.service.deliver(shown[0]?.wakeId ?? "");
      expect(hitsFor(room.webhook.hits, "A2")[0]?.json).toEqual(shown[0]);
    } finally {
      await stopRoom(room);
    }
  });

  it("hides a file at Messages and includes scanned text at Messages + files", async () => {
    const room = await setupRoom({ sameOwnerAgent: true });
    try {
      const text = "The checklist is complete.";
      insertFile(room.db, { mediaType: "text/plain; charset=utf-8", bytes: Buffer.from(text) });
      setSharing(room.db, "O1", "O2", "messages");
      const hidden = room.service.enqueue(enqueueInput({ itemKind: "file", itemId: "file_1" }));
      const other = hidden.find((event) => event.recipient.agentId === "A2");
      const same = hidden.find((event) => event.recipient.agentId === "A1b");
      expect(other?.disclosure).toBe("activity_only");
      expect(JSON.stringify(other)).not.toContain(text);
      expect(JSON.stringify(other)).not.toContain("notes.txt");
      expect(same?.disclosure).toBe("content");
      expect(same?.content).toMatchObject({ kind: "file", name: "notes.txt", textBody: text, byteLength: text.length });

      room.db.prepare("DELETE FROM wakes").run();
      setSharing(room.db, "O1", "O2", "messages_files");
      insertFile(room.db, {
        id: "file_2",
        name: "figure.bin",
        mediaType: "image/png",
        bytes: Buffer.from([0xff, 0xfe, 0xfd]),
        metadata: {},
      });
      const binary = room.service
        .enqueue(enqueueInput({ itemKind: "file", itemId: "file_2" }))
        .find((event) => event.recipient.agentId === "A2");
      expect(binary?.disclosure).toBe("content");
      expect(binary?.activity).toEqual({ itemKind: "file" });
      expect(binary?.content).toEqual({
        kind: "file",
        itemId: "file_2",
        name: "figure.bin",
        mediaType: "image/png",
        byteLength: 3,
        metadata: {},
      });
      expect(binary?.content).not.toHaveProperty("textBody");

      insertFile(room.db, {
        id: "file_3",
        name: "broken.txt",
        mediaType: "text/plain",
        bytes: Buffer.from([0xff, 0xfe]),
      });
      const undecodable = room.service
        .enqueue(enqueueInput({ itemKind: "file", itemId: "file_3" }))
        .find((event) => event.recipient.agentId === "A2");
      expect(undecodable?.content).not.toHaveProperty("textBody");
      expect(undecodable?.content).toMatchObject({ byteLength: 2, mediaType: "text/plain" });
    } finally {
      await stopRoom(room);
    }
  });

  it("does not enqueue a held message or file", async () => {
    const room = await setupRoom({ sameOwnerAgent: true });
    try {
      insertMessage(room.db, { held: true });
      insertFile(room.db, { held: true });
      setSharing(room.db, "O1", "O2", "messages_files");
      expect(room.service.enqueue(enqueueInput())).toEqual([]);
      expect(room.service.enqueue(enqueueInput({ itemKind: "file", itemId: "file_1" }))).toEqual([]);
      expect(room.db.prepare("SELECT COUNT(*) AS n FROM wakes").get()).toEqual({ n: 0 });
      await room.service.deliverPending();
      expect(room.webhook.hits).toEqual([]);
      expect(room.mail.messages).toEqual([]);
      expect(expectChain(room.db)).toEqual([]);
    } finally {
      await stopRoom(room);
    }
  });

  it("rejects a missing item, a mismatched author, and a mismatched message round", async () => {
    const room = await setupRoom();
    try {
      insertMessage(room.db, { round: 1 });
      expect(() => room.service.enqueue(enqueueInput({ itemId: "post_missing" }))).toThrow(/not found/);
      expect(() => room.service.enqueue(enqueueInput({ authorAgentId: "A2", authorOwnerId: "O2" }))).toThrow(/author/);
      expect(() => room.service.enqueue(enqueueInput({ round: 2 }))).toThrow(/round/);
      expect(room.db.prepare("SELECT COUNT(*) AS n FROM wakes").get()).toEqual({ n: 0 });
    } finally {
      await stopRoom(room);
    }
  });
});
