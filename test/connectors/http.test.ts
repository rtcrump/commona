import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("still answers when forgetting a retired handoff cannot be saved", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "commona-mcp-"));
    const statePath = join(stateDir, "links.json");
    const handoff = "handoff-retired-fake";
    const roomId = "room-guest-fake";
    const guestToken = "guest-token-fake";
    let handoffLive = true;
    const fetchImpl: typeof fetch = async (input) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw).pathname;
      if (path === "/connect/handoff") {
        return jsonResponse(handoffLive ? { ok: true } : { error: "refused" }, handoffLive ? 200 : 403);
      }
      if (path === "/connect/claim") {
        return jsonResponse({ credential: guestToken, agentId: "agent-guest-fake", roomId });
      }
      if (path === "/connect/arrive" || path === "/connect/pending") return jsonResponse({});
      if (path.endsWith("/feed")) return jsonResponse({ posts: [] });
      return jsonResponse({ error: "missing" }, 404);
    };
    const server = await startMcpHttp({
      config: {
        baseUrl: "http://room.example.test",
        roomId: "room-host-fake",
        agentId: "agent-host-fake",
        agentToken: "host-token-fake",
        wakePollMs: 60_000,
      },
      bearer: "test-bearer",
      statePath,
      fetchImpl,
    });
    let locked = false;
    try {
      const link = `${server.url}?handoff=${encodeURIComponent(handoff)}&room=${encodeURIComponent(roomId)}`;
      const opened = await postJson(link, initializeBody());
      expect(opened.status).toBe(200);
      expect(opened.sessionId).not.toBe("");
      const saved = JSON.parse(readFileSync(statePath, "utf8")) as { links?: unknown[] };
      expect(saved.links).toHaveLength(1);

      handoffLive = false;
      chmodSync(stateDir, 0o555);
      locked = true;

      const retired = await postJson(link, initializeBody());
      expect(retired.status).toBe(401);
      expect(retired.body).toContain("unauthorized");
      expect(retired.body).not.toContain(guestToken);
      expect(retired.body).not.toContain(handoff);
      const kept = JSON.parse(readFileSync(statePath, "utf8")) as { links?: unknown[] };
      expect(kept.links).toHaveLength(1);

      const stillUp = await postJson(server.url, initializeBody(), { authorization: "Bearer test-bearer" });
      expect(stillUp.status).toBe(200);
      expect(stillUp.sessionId).not.toBe("");
      expect(stillUp.body).not.toContain(guestToken);
      expect(stillUp.body).not.toContain("host-token-fake");
    } finally {
      if (locked) chmodSync(stateDir, 0o700);
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
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
    signal: AbortSignal.timeout(2_000),
  });
  return {
    status: response.status,
    body: await response.text(),
    sessionId: response.headers.get("mcp-session-id") ?? "",
  };
}
