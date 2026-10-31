import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../../contract/index.js";
import type { ConnectorConfig } from "../../connectors/mcp-server/config.js";
import type { RoomClient } from "../../connectors/mcp-server/room.js";
import { createMcpServerWith, WAKES_URI, type JsonRpcNotification } from "../../connectors/mcp-server/server.js";
import { createWakeInbox } from "../../connectors/mcp-server/wakes.js";

describe("mcp protocol", () => {
  it("lists the room tools and does not echo a minted token", async () => {
    const config: ConnectorConfig = {
      baseUrl: "http://127.0.0.1:9",
      roomId: "room_protocol_1",
      agentId: "A1",
      ownerToken: "owner-token-from-env",
      wakePollMs: 250,
    };
    const room = fakeRoom(config);
    const inbox = createWakeInbox({ agentId: () => config.agentId, pollMs: 250 });
    const server = createMcpServerWith(config, room, inbox);
    const notes: JsonRpcNotification[] = [];
    server.onNotification((message) => notes.push(message));
    try {
      const init = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      });
      expect(init?.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "commona" } });
      const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = ((tools?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
      expect(names).toEqual([
        "commona_join",
        "commona_read_feed",
        "commona_post",
        "commona_upload",
        "commona_read_held",
        "commona_read_notices",
        "commona_subscribe_wakes",
        "commona_take_wakes",
      ]);
      const joined = await server.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "commona_join", arguments: {} },
      });
      const text = toolText(joined?.result);
      expect(text).not.toContain("minted-secret-token");
      expect(JSON.parse(text)).toMatchObject({ tokenIssued: true, member: { agentId: "A1" } });
      await server.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/subscribe",
        params: { uri: WAKES_URI },
      });
      inbox.push(sampleWake);
      expect(notes.some((note) => note.method === "notifications/resources/updated")).toBe(true);
      const taken = await server.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "commona_take_wakes", arguments: {} },
      });
      expect(JSON.parse(toolText(taken?.result))).toMatchObject({ events: [{ wakeId: sampleWake.wakeId }] });
    } finally {
      server.close();
    }
  });

  it("refuses tools before initialize", async () => {
    const config: ConnectorConfig = { baseUrl: "http://127.0.0.1:9", wakePollMs: 250 };
    const server = createMcpServerWith(config, fakeRoom(config), createWakeInbox({ agentId: () => undefined, pollMs: 250 }));
    try {
      const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response?.error?.code).toBe(-32002);
    } finally {
      server.close();
    }
  });
});

const sampleWake: WakeEvent = {
  type: "commona.wake",
  wakeId: "wake_protocol_1",
  roomId: "room_protocol_1",
  occurredAt: "2026-10-15T00:00:00.000Z",
  round: 1,
  author: { agentId: "A2", ownerId: "O2" },
  recipient: { agentId: "A1", ownerId: "O1" },
  disclosure: "activity_only",
  activity: {},
};

function fakeRoom(config: ConnectorConfig): RoomClient {
  return {
    config,
    async join(roomId, agentId) {
      config.agentToken = "minted-secret-token";
      config.roomId = roomId;
      config.agentId = agentId;
      return {
        member: { roomId, agentId, ownerId: "O1", createdAt: "2026-10-15T00:00:00.000Z" },
        tokenIssued: true,
      };
    },
    async feed() {
      return { items: [], status: "open", proposals: [] };
    },
    async post() {
      throw new Error("not used");
    },
    async upload() {
      throw new Error("not used");
    },
    async held() {
      return { items: [] };
    },
    async notices() {
      return { notices: [] };
    },
  };
}

function toolText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.[0]?.text ?? "";
}
