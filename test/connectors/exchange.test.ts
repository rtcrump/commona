import { describe, expect, it } from "vitest";
import type { FeedItem, WakeEvent } from "../../contract/index.js";
import { loadConfig } from "../../connectors/mcp-server/config.js";
import { startMcpHttp } from "../../connectors/mcp-server/http.js";
import { startWakeListener } from "../../src/listener/index.js";
import { spoolHandoff } from "../../src/listener/handoff.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { McpStdioClient, type ToolOutcome } from "./stdio-client.js";
import { freshSpool, roomSend, startConnectorRoom } from "./room.js";

describe("two mcp clients", () => {
  it("exchanges a message, a file, and a wake across owners", async () => {
    const fixtures = loadFixtures();
    const firstText = fixtures.normalMessages[0] ?? "";
    const replyText = fixtures.normalMessages[1] ?? "";
    const fileText = fixtures.normalMessages[2] ?? "";
    const blockedName = fixtures.names[0] ?? "";
    const room = await startConnectorRoom();
    const spool = freshSpool();
    const listener = await startWakeListener({ handoff: spoolHandoff(spool) });
    room.db.prepare("UPDATE agents SET webhook_url = ?").run(`${listener.url}/wake`);
    const created = await roomSend(room.baseUrl, "POST", "/rooms", room.ownerTokens.O1);
    expect(created.status).toBe(201);
    const roomId = (created.body as { room: { id: string } }).room.id;
    const stdio = new McpStdioClient({
      COMMONA_BASE_URL: room.baseUrl,
      COMMONA_ROOM_ID: roomId,
      COMMONA_AGENT_ID: "A1",
      COMMONA_OWNER_TOKEN: room.ownerTokens.O1,
      COMMONA_WAKE_SPOOL: spool,
      COMMONA_WAKE_POLL_MS: "40",
    });
    const httpServer = await startMcpHttp({
      config: loadConfig({
        COMMONA_BASE_URL: room.baseUrl,
        COMMONA_ROOM_ID: roomId,
        COMMONA_AGENT_ID: "A2",
        COMMONA_OWNER_TOKEN: room.ownerTokens.O2,
        COMMONA_WAKE_SPOOL: spool,
        COMMONA_WAKE_POLL_MS: "40",
      }),
    });
    const http = new HttpMcp(httpServer.url);
    try {
      await stdio.initialize();
      await http.initialize();
      const joinedA = await stdio.callTool("commona_join");
      const joinedB = await http.callTool("commona_join");
      expect(joinedA.isError).toBe(false);
      expect(joinedB.isError).toBe(false);
      expect(joinedA.text).not.toMatch(/"token"\s*:/);
      expect(joinedB.text).not.toMatch(/"token"\s*:/);
      expect(joinedA.json).toMatchObject({ tokenIssued: true, member: { agentId: "A1", ownerId: "O1" } });
      expect(joinedB.json).toMatchObject({ tokenIssued: true, member: { agentId: "A2", ownerId: "O2" } });

      expect((await roomSend(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, room.ownerTokens.O1, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      })).status).toBe(200);
      expect((await roomSend(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, room.ownerTokens.O2, {
        fromOwnerId: "O2",
        toOwnerId: "O1",
        level: "messages_files",
      })).status).toBe(200);

      await stdio.callTool("commona_subscribe_wakes");
      await http.callTool("commona_subscribe_wakes");
      await http.openEvents();

      const posted = await stdio.callTool("commona_post", { text: firstText });
      expect(posted.isError).toBe(false);
      expect(posted.json).toMatchObject({ outcome: "accepted" });
      const postId = (posted.json as { post: { id: string } }).post.id;

      const toB = await waitForEvents(() => http.callTool("commona_take_wakes"));
      expect(toB[0]?.disclosure).toBe("content");
      expect(toB[0]?.content).toMatchObject({ kind: "message", text: firstText });
      expect(http.notes.some((note) => note.method === "notifications/resources/updated")).toBe(true);
      const feedB = await http.callTool("commona_read_feed");
      expect(feedB.isError).toBe(false);
      expect(messageTexts(feedB.json)).toContain(firstText);

      const reply = await http.callTool("commona_post", { text: replyText, replyToId: postId });
      expect(reply.isError).toBe(false);
      const toA = await waitForEvents(() => stdio.callTool("commona_take_wakes"));
      expect(toA[0]?.content).toMatchObject({ kind: "message", text: replyText });
      expect(stdio.notifications.some((note) => note.method === "notifications/resources/updated")).toBe(true);
      const feedA = await stdio.callTool("commona_read_feed");
      expect(messageTexts(feedA.json)).toEqual([firstText, replyText]);

      const uploaded = await stdio.callTool("commona_upload", {
        filename: "synthetic-note.txt",
        mediaType: "text/plain",
        text: fileText,
      });
      expect(uploaded.isError).toBe(false);
      expect(uploaded.json).toMatchObject({ outcome: "accepted", file: { name: "synthetic-note.txt" } });
      const fileWake = await waitForEvents(() => http.callTool("commona_take_wakes"));
      expect(fileWake[0]?.content).toMatchObject({ kind: "file", name: "synthetic-note.txt" });
      const feedWithFile = await http.callTool("commona_read_feed");
      expect(feedWithFile.isError).toBe(false);
      const items = (feedWithFile.json as { items: FeedItem[] }).items;
      expect(items.some((item) => item.kind === "file" && item.name === "synthetic-note.txt")).toBe(true);

      const heldPost = await stdio.callTool("commona_post", { text: `Held example ${blockedName}` });
      expect(heldPost.isError).toBe(false);
      expect(heldPost.json).toMatchObject({ outcome: "held" });
      await delay(400);
      const noWake = await http.callTool("commona_take_wakes");
      expect(noWake.isError).toBe(false);
      expect((noWake.json as { events: WakeEvent[] }).events).toEqual([]);
      const hidden = await http.callTool("commona_read_feed");
      expect(hidden.text).not.toContain(blockedName);

      const held = await stdio.callTool("commona_read_held");
      expect(held.isError).toBe(false);
      const heldItems = (held.json as { items: { text?: string }[] }).items;
      expect(heldItems.some((item) => item.text?.includes(blockedName))).toBe(true);
      const otherHeld = await http.callTool("commona_read_held");
      expect(otherHeld.text).not.toContain(blockedName);
      const notices = await stdio.callTool("commona_read_notices");
      expect(notices.isError).toBe(false);
      const noticeRows = (notices.json as { notices: { kind: string; message: string }[] }).notices;
      expect(noticeRows.some((notice) => notice.kind === "block")).toBe(true);
      for (const notice of noticeRows) expect(notice.message).not.toContain(blockedName);
    } finally {
      http.close();
      await stdio.close();
      await httpServer.close();
      await listener.close();
      await room.stop();
    }
  }, 40_000);
});

class HttpMcp {
  readonly notes: { method?: string }[] = [];
  private sessionId: string | undefined;
  private nextId = 1;
  private eventsAbort = new AbortController();

  constructor(private readonly url: string) {}

  async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "commona-http-test", version: "0" },
    })) as { protocolVersion?: string };
    expect(result.protocolVersion).toBe("2025-06-18");
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(response.status).toBe(202);
  }

  async openEvents(): Promise<void> {
    const response = await fetch(this.url, {
      headers: { accept: "text/event-stream", "mcp-session-id": this.sessionId ?? "" },
      signal: this.eventsAbort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`sse open failed: ${response.status}`);
    void readEvents(response.body, (message) => this.notes.push(message), this.eventsAbort.signal);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
    let json: unknown = text;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
    return { isError: result.isError === true, text, json };
  }

  close(): void {
    this.eventsAbort.abort();
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "mcp error");
    return body.result;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: { method?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        onMessage(JSON.parse(data) as { method?: string });
      }
    }
  } catch {
    // The test aborts the stream on cleanup.
  }
}

async function waitForEvents(take: () => Promise<ToolOutcome>, timeoutMs = 8_000): Promise<WakeEvent[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const outcome = await take();
    if (outcome.isError) throw new Error(outcome.text);
    const events = (outcome.json as { events?: WakeEvent[] }).events ?? [];
    if (events.length > 0) return events;
    await delay(40);
  }
  throw new Error("timed out waiting for a wake");
}

function messageTexts(body: unknown): string[] {
  const items = (body as { items?: FeedItem[] }).items ?? [];
  return items.filter((item) => item.kind === "message").map((item) => item.text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
