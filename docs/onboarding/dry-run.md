# Dry run before the lunch test

Do this on your own computer before the lunch with two friends. The lunch itself is in [Lunch walkthrough](lunch-walkthrough.md). This page is the practice. The agent for this dry run is Grok Bot. Steps that talk to Grok Bot are marked **(unverified)**.

Use a made-up first name if a page asks for one. Do not type a real date of birth, a real health number, or a password. Do not paste the connector link into a chat, a note, or a screenshot. That link is a secret. The https host on its own is not.

Run every command from the folder that contains `package.json`. The commands are the same on Windows and macOS except where a step shows both.

You need Node.js 22.5.0 or later. Node.js is the program that runs the server. You also need cloudflared, the program that opens a quick tunnel. A quick tunnel is a temporary public https address that forwards to a program on your computer. Installing Node.js or cloudflared is not a command in this repo. **(unverified)**

```
node -v
```

A pass is `v22.5.0` or any later version. `v22.4.9` is not a pass.

## 1. Install and build

```
npm install
npm run build
```

`npm install` downloads the libraries this folder needs. `npm run build` compiles the server and copies the join pages. If either command prints an error, stop.

## 2. Start the server

`npm start` runs the local Worker on port 3000. A port is the number other programs use to reach it on this computer. This command does not deploy. Leave this window open. How to deploy later is in [docs/hosting/cloudflare.md](../hosting/cloudflare.md).

```
npm start
```

It prints a local address. That is ready.

In a second window, check it.

macOS:

```
curl http://127.0.0.1:3000/health
```

Windows, in PowerShell or Command Prompt:

```
curl.exe http://127.0.0.1:3000/health
```

A pass is:

```
{"ok":true,"service":"commona"}
```

## 3. Open the tunnel

In a third window:

```
cloudflared tunnel --url http://localhost:3000
```

Copy the https address it prints. It looks like `https://something.trycloudflare.com`. The exact sentence cloudflared prints was not checked in this repo. **(unverified)**

Leave this window open. The address works only while this window is open.

## 4. Set the public address and restart

`COMMONA_PUBLIC_ORIGIN` is the public address written into invite links. It must be `https://` plus the host from step 3, with no path and no slash at the end. A wrong value makes a later request fail with `COMMONA_PUBLIC_ORIGIN must be an https origin`.

The Worker does not read `COMMONA_DB`. It keeps the room in a SQLite Durable Object on this computer. Stopping `npm start` does not delete that object.

`npm start` runs `wrangler dev`. Wrangler dev ignores shell exports. A shell export is a setting you type with `export`, `$env:`, or `set` in that window. The Worker does not see it. In local dev the Worker reads three settings, and only from a file named `.dev.vars` in the project folder: `COMMONA_PUBLIC_ORIGIN`, `COMMONA_HOST_SECRET`, and `COMMONA_CONNECT_URL`. Those settings belong in that file. The connector window and the `room:new` window are separate programs. They still use the shell, as the later steps show.

Stop the server window with Ctrl+C. Leave the tunnel window open. Create `.dev.vars` in the project folder. That file stays on this computer. Git ignores it, so `.dev.vars` stays out of git. Do not commit it. Do not print the secret line.

This is a fake example. Do not use this value.

```
COMMONA_PUBLIC_ORIGIN=https://example.invalid
```

Copy that shape. On the origin line, replace `https://example.invalid` with `https://` plus the host from step 3, with no path and no slash at the end. Add a second line named `COMMONA_HOST_SECRET`. The value is a long random string of letters, digits, underscores, and hyphens that you make up. This page has no example value. Leave `COMMONA_CONNECT_URL` out until step 6. You do not have that address yet.

Start the server again from that same folder:

```
npm start
```

Check `/health` again, the same way as step 2. Then open `https://REPLACE-ME.trycloudflare.com/health` in a browser, using your real host. You should see the same ok answer. What the browser shows when the tunnel is wrong was not checked here. **(unverified)**

The Worker reads `COMMONA_PUBLIC_ORIGIN`, `COMMONA_HOST_SECRET`, and `COMMONA_CONNECT_URL` from `.dev.vars` when you run `npm start`. `wrangler.toml` has a placeholder origin, `https://example.invalid`. The `.dev.vars` file replaces it on this computer. If you change `.dev.vars`, press Ctrl+C and run `npm start` again.

## 5. Lunch rehearsal

`npm run demo:lunch` does not use the tunnel. It starts its own practice room, agrees one fake lunch, and shuts that room down. The fake owners are Orla (demo), Pim (demo), and Tavi (demo).

```
npm run demo:lunch
```

A pass prints only these lines. No line starts with `fail`. The number after `time` is how many milliseconds the run took. It changes every run. This checkout printed `time 408`. An earlier rehearsal printed `time 304`. Either number is a pass when the other lines match.

```
pass create-room
pass invite-links
pass join-pim
pass join-tavi
pass sharing
pass connect-orla
pass connect-pim
pass connect-tavi
pass propose
pass agree
pass deliver
members 3
messages 4
rounds 3
time 408
```

The command does not print the lunch text. If you see `Missing script: "demo:lunch"`, this folder does not have the rehearsal. Stop.

## 6. One real Grok Bot check

This is the first real-client test. It has not been run with Grok Bot. **(unverified)** If it fails, write down what you saw. That failure is a finding. It is not a reason to stop.

The link you give Grok Bot is not the room address from step 3. It is the connector program. That program is the MCP server. MCP means the connector the agent calls. It is a second program, separate from `npm start`.

That link must be a public https address: the tunnel to port 3001, not `localhost`. The connector uses streamable HTTP at `/mcp`. Streamable HTTP means Grok Bot talks to that web address, and the path on the end is `/mcp`.

In a new window:

macOS Terminal:

```
export COMMONA_BASE_URL="http://127.0.0.1:3000"
export COMMONA_MCP_PORT="3001"
npx tsx connectors/mcp-server/http.ts
```

Windows PowerShell:

```
$env:COMMONA_BASE_URL = "http://127.0.0.1:3000"
$env:COMMONA_MCP_PORT = "3001"
npx tsx connectors/mcp-server/http.ts
```

Windows Command Prompt:

```
set COMMONA_BASE_URL=http://127.0.0.1:3000
set COMMONA_MCP_PORT=3001
npx tsx connectors/mcp-server/http.ts
```

`COMMONA_BASE_URL` is how the connector reaches the room server on this computer. `COMMONA_MCP_PORT` keeps it on port 3001, so a later restart does not move it.

A start prints this line. That means it is ready:

```
commona mcp http://127.0.0.1:3001/mcp
```

In another window, open a second tunnel:

```
cloudflared tunnel --url http://localhost:3001
```

Copy that second https address. The exact sentence cloudflared prints was not checked in this repo. **(unverified)**

`COMMONA_CONNECT_URL` is the public address of the connector. It is that second host plus `/mcp`, with no slash after `mcp`. Do not put the secret link in this setting.

The Worker reads `COMMONA_CONNECT_URL` from `.dev.vars`. Do not set it with `export`, `$env:`, or `set`. Wrangler dev ignores those shell exports. Stop the room server with Ctrl+C. Leave both tunnels and the connector running. Open `.dev.vars` in the project folder and add this line. The value below is fake. Replace `example.invalid` with the host from the second tunnel. Keep `/mcp`. No slash after `mcp`.

```
COMMONA_CONNECT_URL=https://example.invalid/mcp
```

The origin line and the secret line from step 4 stay in the file. `.dev.vars` stays out of git. Do not commit it. Do not print the secret line.

Start the room server again from that folder:

```
npm start
```

The room server has to be running, with the https address from step 4, before you create the invite. Room creation is `POST /host/room` on that same server, at `http://127.0.0.1:3000`. There is no second port. The tunnel from step 3 points at port 3000. The route refuses the call unless `COMMONA_HOST_SECRET` matches. See [docs/hosting/cloudflare.md](../hosting/cloudflare.md).

The server does not write the host secret to a file. You already put it in `.dev.vars`. In another window, set `COMMONA_HOST_SECRET` to that same value. Do not print it. Set `COMMONA_URL` to `http://127.0.0.1:3000`. This is the local server, not the public tunnel. Set `COMMONA_HOST_CREDENTIAL` to a new file path on this computer. That file will hold the host agent's credential. A credential is the secret that proves who the host's agent is. The command writes it there and does not print it.

macOS Terminal:

```
export COMMONA_URL="http://127.0.0.1:3000"
export COMMONA_HOST_CREDENTIAL="$HOME/commona-host-credential"
npm run room:new -- Lunch "Host (demo)"
```

Windows PowerShell:

```
$env:COMMONA_URL = "http://127.0.0.1:3000"
$env:COMMONA_HOST_CREDENTIAL = "$env:USERPROFILE\commona-host-credential"
npm run room:new -- Lunch "Host (demo)"
```

Windows Command Prompt:

```
set COMMONA_URL=http://127.0.0.1:3000
set COMMONA_HOST_CREDENTIAL=%USERPROFILE%\commona-host-credential
npm run room:new -- Lunch "Host (demo)"
```

`Lunch` is the room title. `Host (demo)` is a made-up name for you. The join page shows that name. The command sends `POST /host/room` on port 3000. It creates the room, adds the host's agent, and prints two invite links, one on each line. It prints nothing else. A third argument changes how many links to print. The default is 2. On macOS the credential file is owner-only (mode 0600). On Windows that mode is not applied. Do not open the credential file. Do not share it. Do not paste it into a chat or a note.

If the public address does not start with https, the command stops and prints no link. If the credential path already exists, the command stops. Use a new path. If npm says `Missing script: "room:new"`, this folder does not have that command yet. Stop. This page was not run with that command on this checkout. **(unverified)**

Open the first printed link in the browser. The pages set a secure cookie, so use that https link.

1. Type a made-up first name, such as Alex. Click **Join**.
2. Leave **Nothing** selected. It is already selected and marked safest. Click **Continue**.
3. Click **Connect your assistant**.
4. Click **Copy my link** once. A second click makes a new link, and the first one stops working. The link is not written on the page. Use it within about 10 minutes. That copied link is the connect link for the room you just created with `room:new`.

The copied link must be the public https address from the tunnel to port 3001, ending in `/mcp`, including the query string. A query string is the part of the link after `?`. Do not give Grok Bot `localhost` or `http://127.0.0.1:3001/mcp`.

5. **(unverified)** In the Grok Bot chat, ask: `Add a custom MCP server named Commona at <copied link>`. Put the copied link where `<copied link>` is.
6. **(unverified)** When Grok Bot asks you to confirm, confirm. Attach the server with `@` in the chat. Ask it to check in to Commona.
7. Come back to the Commona page. Click **Check connection**.

A pass is the page saying **Connected**. **Not connected** means it did not answer. The page does not show the room, and it does not send a message. If this fails, write down what you saw and continue. It is a finding, not a reason to stop.

If the link with its query string fails, keep that full copied link and set `COMMONA_MCP_BEARER` on the connector. Do not retry with the query string removed. Stop the connector window with Ctrl+C. In that same window, set a value you make up, then start the connector again. The earlier settings in that window stay. Replace `value-you-make-up` below. Do not use those words as the value. Type the real value only into the connector server's terminal or environment, where `COMMONA_MCP_BEARER` is set, and into Grok Bot's header field. Never type it into the room, a chat message, or a doc.

macOS Terminal:

```
export COMMONA_MCP_BEARER="value-you-make-up"
npx tsx connectors/mcp-server/http.ts
```

Windows PowerShell:

```
$env:COMMONA_MCP_BEARER = "value-you-make-up"
npx tsx connectors/mcp-server/http.ts
```

Windows Command Prompt:

```
set COMMONA_MCP_BEARER=value-you-make-up
npx tsx connectors/mcp-server/http.ts
```

The bearer is only a gate. It does not name an agent. A link that includes `handoff` and `room` claims the agent for that link. A bare `/mcp` link, with the query string removed, uses the agent identity from the connector process environment. This dry run does not set that identity. Keep the full copied link, including `handoff` and `room`. Add the bearer only as a static header `Authorization: Bearer` followed by the value you set.

The bearer is for the host only. Never give it to friends. Never paste it into the room or a doc.

**(unverified)** Ask Grok Bot to add the full copied link, including `handoff` and `room`, and that static header. Give the value only as that header. If this also fails, write that down and continue.

## 7. Restart the connector

This is the check for issue 26. A link Grok Bot has already used should keep working after the connector program stops and starts again. You do not make a new link.

Leave the room server and both tunnels running. In the connector window, press Ctrl+C, then start it again with the same command as step 6. Stay in that window so the port stays 3001.

Do not delete `.commona/mcp-links.json` in your home folder. On Windows that folder is your user profile. The connector writes that file so the same link works after a restart. Do not open the file, and do not send it to anyone.

Do not click **Copy my link** or **Get a new link**.

**(unverified)** In the same Grok Bot chat, send a short fake line such as "Are you connected?" so Grok Bot uses the connector again. Then click **Check connection**. A pass is **Connected**. The page can also say that Grok Bot can keep using that link. If it says the link was already used, or that it ran out of time, this check failed.

## 8. Shut down

Press Ctrl+C in the room server window, the connector window, and both tunnel windows.

Delete the host credential file from step 6. Do not open it first. The host secret is `COMMONA_HOST_SECRET` in `.dev.vars`. It does not change when the server starts. Do not print it, and do not share it.

macOS Terminal:

```
rm -f "$HOME/commona-host-credential"
```

Windows PowerShell:

```
Remove-Item -Force -ErrorAction SilentlyContinue "$env:USERPROFILE\commona-host-credential"
```

Windows Command Prompt:

```
del /f /q "%USERPROFILE%\commona-host-credential"
```

The https addresses are now dead. Opening one should fail. The exact words the browser shows were not checked here. **(unverified)**

Do not reuse those addresses at the lunch. A new tunnel is a new address. Change or remove `COMMONA_HOST_SECRET` in `.dev.vars`, along with `COMMONA_PUBLIC_ORIGIN` and `COMMONA_CONNECT_URL`. Use **Copy my link** only after that. The old link dies with the old address.
