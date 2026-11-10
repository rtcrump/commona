import { describe, expect, it } from "vitest";
import { loadConfig } from "../../connectors/mcp-server/config.js";
import { startMcpHttp } from "../../connectors/mcp-server/http.js";

describe("mcp streamable http", () => {
  it("rejects a missing bearer and a missing session", async () => {
    const server = await startMcpHttp({
      config: loadConfig({ COMMONA_BASE_URL: "http://127.0.0.1:9", COMMONA_WAKE_POLL_MS: "1000" }),
      bearer: "test-bearer",
    });
    try {
      const denied = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(denied.status).toBe(401);
      const opened = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-bearer",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      });
      expect(opened.status).toBe(200);
      const session = opened.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      const missing = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: "Bearer test-bearer",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(missing.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("requires the bearer and does not adopt the host identity for a guest initialize", async () => {
    const hostToken = "host-token-fake";
    const guestToken = "guest-token-fake";
    const handoff = "handoff-guest-fake";
    const hostRoom = "room-host-fake";
    const guestRoom = "room-guest-fake";
    const calls: { url: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      calls.push({ url: raw, authorization });
      const path = new URL(raw).pathname;
      if (path === "/connect/handoff") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { handoff?: string; roomId?: string };
        const ok = body.handoff === handoff && body.roomId === guestRoom;
        return jsonResponse(ok ? {} : { error: "refused" }, ok ? 200 : 403);
      }
      if (path === "/connect/claim") {
        return jsonResponse({ credential: guestToken, agentId: "agent-guest-fake", roomId: guestRoom });
      }
      if (path === "/connect/arrive" || path === "/connect/pending") return jsonResponse({});
      if (path.endsWith("/feed")) return jsonResponse({ posts: [] });
      return jsonResponse({ error: "missing" }, 404);
    };
    const server = await startMcpHttp({
      config: {
        baseUrl: "http://room.example.test",
        roomId: hostRoom,
        agentId: "agent-host-fake",
        agentToken: hostToken,
        wakePollMs: 60_000,
      },
      bearer: "test-bearer",
      fetchImpl,
    });
    try {
      const opened = await postJson(`${server.url}?handoff=${handoff}&room=${guestRoom}`, initializeBody());
      expect(opened.status).toBe(200);
      expect(opened.sessionId).not.toBe("");
      expect(opened.body).toContain("2025-06-18");

      const bare = await postJson(server.url, initializeBody(), { "mcp-session-id": opened.sessionId });
      expect(bare.status).toBe(401);
      expect(bare.sessionId).toBe("");

      const guestRead = await postJson(
        `${server.url}?handoff=${handoff}&room=${guestRoom}`,
        toolBody("commona_read_feed"),
        { "mcp-session-id": opened.sessionId },
      );
      expect(guestRead.status).toBe(200);
      expect(guestRead.body).toContain("posts");
      expect(guestRead.body).not.toContain(hostToken);
      expect(guestRead.body).not.toContain(hostRoom);

      const authed = await postJson(server.url, initializeBody(), {
        "mcp-session-id": opened.sessionId,
        authorization: "Bearer test-bearer",
      });
      expect(authed.status).toBe(200);
      const authedSession = authed.sessionId || opened.sessionId;
      const authedRead = await postJson(
        `${server.url}?handoff=${handoff}&room=${guestRoom}`,
        toolBody("commona_read_feed"),
        { "mcp-session-id": authedSession },
      );
      expect(authedRead.status).toBe(200);
      expect(authedRead.body).not.toContain(hostToken);
      expect(authedRead.body).not.toContain(hostRoom);

      const hostUse = calls.filter((call) => call.authorization.includes(hostToken) || call.url.includes(hostRoom));
      expect(hostUse).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
}

function toolBody(name: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; sessionId: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
    sessionId: response.headers.get("mcp-session-id") ?? "",
  };
}
