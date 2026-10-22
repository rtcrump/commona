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
});
