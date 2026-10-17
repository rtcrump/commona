# Add Commona in Grok Bot

This is the route we believe works. Saturday 17 October 2026 is the first real test. We have not watched Grok Bot connect yet. Steps we have not tried are marked **(unverified)**.

You will ask Grok Bot to add one link. That link is yours. You copy it from your own join page. The host cannot make it for you.

## Before you start

Open the invite the host sent you. Join the room. Open **Connect your assistant**. Click **Copy my link** once. That puts your connect link on the clipboard. It is not written on the page. A second click makes a new link, and the first one stops working.

The link has to start with https. A link that only works on the host's computer, such as localhost, will not do. Grok Bot runs in the cloud, so it has to reach the link over the internet. **(unverified)**

The link uses streamable HTTP, at a path that ends in `/mcp`. That means Grok Bot talks to a web address. Keep the whole link, including the part after the question mark.

`COMMONA_MCP_BEARER` is for the host only. It opens the bare `/mcp` address as the host, not as you. Never ask for it. Never use it. If someone offers it, refuse it.

Keep the link to yourself. Do not paste it into a group chat, a note, or a screenshot.

## Add it

1. In your Grok Bot chat, ask: `Add a custom MCP server named Commona at <link>`. Put the link you just copied where `<link>` is. **(unverified)**
2. When Grok Bot asks you to confirm, confirm. **(unverified)**
3. Attach Commona in the chat with `@`. **(unverified)**
4. Say `check in to Commona`. **(unverified)**
5. Come back to the Commona page and click **Check connection**.

**Connected** means Grok Bot answered. **Not connected** means it did not. The page does not show the room, and it does not send a message.

## If the link fails

Reopen your join page and click **Copy my link** again. Use that new full link in the steps above. Do not ask the host to make a connect link. The host cannot.

If the join page says the invite is expired, or it asks the inviter for a new link, ask the host for a new invite. Join again, then copy your own link.

Do not use `COMMONA_MCP_BEARER`. Do not use a URL with nothing after the question mark. That address is the host only.

## What is not yet verified

This is the first real test, on Saturday 17 October 2026. Nobody has watched these taps on a real Grok Bot:

- The exact sentence in the list above.
- Confirming when Grok Bot asks.
- Attaching the server with `@`.
- Saying "check in to Commona", then **Check connection**.
- Copying your link again from your own join page after the first one fails.
- Asking the host for a new invite only when the join itself is expired.

We read a Cursor staff reply on a forum, not a product docs page: [Grokbot custom connectors](https://forum.cursor.com/t/grokbot-custom-connectors/169965) (30 August 2026). The reply says there is no settings form, that you tell the bot in chat to add a public https address, and that localhost will not work. It names streamable HTTP or SSE. This server speaks streamable HTTP. It does not speak SSE.
