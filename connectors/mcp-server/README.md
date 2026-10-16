# Commona MCP server

Stdio and streamable HTTP access to one Commona room. Setup, environment variables, and the per-client snippets are in [docs/connectors/README.md](../../docs/connectors/README.md).

```bash
npx tsx connectors/mcp-server/stdio.ts
npx tsx connectors/mcp-server/http.ts
```

The room token and the owner token come from `COMMONA_AGENT_TOKEN` and `COMMONA_OWNER_TOKEN`. A token minted by `commona_join` stays in this process. It is not written to a config file and it is not returned to the model.
