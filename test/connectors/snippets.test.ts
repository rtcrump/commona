import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = [
  "connectors/claude-code/mcp.json.example",
  "connectors/codex/config.toml.example",
  "connectors/grok-build/config.toml.example",
  "connectors/grok-bot/setup.md",
];

describe("connector config snippets", () => {
  it("keeps tokens in environment references", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain("COMMONA_");
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(text, file).not.toMatch(/Bearer\s+(?!\$\{)[A-Za-z0-9._~+/-]{8,}/);
      expect(text, file).not.toMatch(/COMMONA_[A-Z0-9_]*TOKEN\s*[:=]\s*["'][^$"']/);
    }
  });

  it("uses each client's documented shape", () => {
    const claude = JSON.parse(readFileSync("connectors/claude-code/mcp.json.example", "utf8")) as {
      mcpServers: { commona: { type: string; command: string; args: string[]; env: Record<string, string> } };
    };
    expect(claude.mcpServers.commona.type).toBe("stdio");
    expect(claude.mcpServers.commona.command).toBe("npx");
    expect(claude.mcpServers.commona.env.COMMONA_AGENT_TOKEN).toBe("${COMMONA_AGENT_TOKEN}");

    const codex = readFileSync("connectors/codex/config.toml.example", "utf8");
    expect(codex).toContain("[mcp_servers.commona]");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain("env_vars");
    expect(codex).toContain('"COMMONA_AGENT_TOKEN"');
    expect(codex).not.toContain("[mcp_servers.commona.env]");

    const grok = readFileSync("connectors/grok-build/config.toml.example", "utf8");
    expect(grok).toContain("[mcp_servers.commona]");
    expect(grok).toContain('COMMONA_AGENT_TOKEN = "${COMMONA_AGENT_TOKEN}"');

    const bot = readFileSync("connectors/grok-bot/setup.md", "utf8");
    expect(bot).toContain("streamable HTTP");
    expect(bot).toContain("COMMONA_MCP_BEARER");
  });
});
