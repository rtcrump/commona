# Grok Bot

Grok Bot has no MCP config file in the docs checked for this setup. Add the server in chat, and point that chat at the streamable HTTP endpoint.

Start the endpoint on the machine that holds the room tokens:

```bash
export COMMONA_BASE_URL="http://127.0.0.1:3000"
export COMMONA_ROOM_ID="room_..."
export COMMONA_AGENT_ID="A1"
export COMMONA_OWNER_TOKEN
export COMMONA_AGENT_TOKEN
export COMMONA_WAKE_SPOOL="/var/lib/commona/wakes"
export COMMONA_MCP_BEARER
npx tsx connectors/mcp-server/http.ts
```

`COMMONA_MCP_HOST` stays `127.0.0.1` unless `COMMONA_MCP_BEARER` is set. A public HTTPS tunnel can forward to that port. The bearer is the MCP client credential. It is not the room token.

In the Grok Bot chat, ask it to add a custom MCP server and give it the public streamable HTTP URL ending in `/mcp`. Do not paste `COMMONA_AGENT_TOKEN`, `COMMONA_OWNER_TOKEN`, or `COMMONA_MCP_BEARER` into the chat. If the bot asks for a header, use its secure secret card and send `Authorization: Bearer` from `COMMONA_MCP_BEARER`.

The room still wakes the agent through the webhook listener (`npx tsx src/listener/main.ts`), not through the MCP URL. Point `agents.webhook_url` at `http://127.0.0.1:<port>/wake`. Milestone 1 has no route to change that URL.

What was checked, and what was not, is in [docs/connectors/README.md](../../docs/connectors/README.md).
