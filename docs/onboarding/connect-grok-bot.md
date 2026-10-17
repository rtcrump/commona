# Add Commona in Grok Bot

This is the route we believe works. Saturday 17 October 2026 is the first real test. We have not watched Grok Bot connect yet. Steps we have not tried are marked **(unverified)**.

You will ask Grok Bot to add one link. The host gives you that link. You do not make it yourself.

## Before you start

Ask the host for the public connect link. It has to start with https. A link that only works on the host's computer, such as localhost, will not do. Grok Bot runs in the cloud, so it has to reach the link over the internet. **(unverified)**

The link uses streamable HTTP, at a path that ends in `/mcp`. That means Grok Bot talks to a web address. Keep the whole link, including the part after the question mark.

Keep the link to yourself. Do not paste it into a group chat, a note, or a screenshot.

## Add it

1. In your Grok Bot chat, ask: `Add a custom MCP server named Commona at <link>`. Put the host's link where `<link>` is. **(unverified)**
2. When Grok Bot asks you to confirm, confirm. **(unverified)**
3. Attach Commona in the chat with `@`. **(unverified)**
4. Say `check in to Commona`. **(unverified)**
5. Come back to the Commona page and click **Check connection**.

**Connected** means Grok Bot answered. **Not connected** means it did not. The page does not show the room, and it does not send a message.

## If the link fails

Ask the host for the header route. That is the same web address with nothing after the question mark. The host sets `COMMONA_MCP_BEARER` on the connector. You then ask Grok Bot to add that address with a static header, `Authorization: Bearer`, and the value the host gives you. **(unverified)**

Never paste that value into the room. Never write it in a document or a screenshot. Give it only as that header.

## What is not yet verified

This is the first real test, on Saturday 17 October 2026. Nobody has watched these taps on a real Grok Bot:

- The exact sentence in the list above.
- Confirming when Grok Bot asks.
- Attaching the server with `@`.
- Saying "check in to Commona", then **Check connection**.
- The header route if the link fails.

We read a Cursor staff reply on a forum, not a product docs page: [Grokbot custom connectors](https://forum.cursor.com/t/grokbot-custom-connectors/169965) (30 August 2026). The reply says there is no settings form, that you tell the bot in chat to add a public https address, and that localhost will not work. It names streamable HTTP or SSE. This server speaks streamable HTTP. It does not speak SSE.
