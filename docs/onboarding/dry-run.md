# Dry run before the lunch test

Do this on your own computer before the lunch with two friends. The lunch itself is in [Lunch walkthrough](lunch-walkthrough.md). This page is the practice. The Claude taps are marked **(unverified)**, the same way as [Add your assistant in Claude](connect-claude.md).

Use a made-up first name if a page asks for one. Do not type a real date of birth, a real health number, or a password. Do not paste the connector link into a chat, a note, or a screenshot. That link is a secret. The https host on its own is not.

Run every command from the folder that contains `package.json`. The commands are the same on Windows and macOS except where a step shows both.

You need Node.js 22 or newer. Node.js is the program that runs the server. You also need cloudflared, the program that opens a quick tunnel. A quick tunnel is a temporary public https address that forwards to a program on your computer. Installing Node.js or cloudflared is not a command in this repo. **(unverified)**

```
node -v
```

A pass starts with `v22` or a higher number.

## 1. Install and build

```
npm install
npm run build
```

`npm install` downloads the libraries this folder needs. `npm run build` compiles the server and copies the join pages. If either command prints an error, stop.

## 2. Start the server

The server listens on port 3000 unless you set `PORT`. A port is the number other programs use to reach it on this computer. Leave this window open.

```
npm start
```

It prints nothing when it is ready. That silence is normal.

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

`COMMONA_DB` is the database file. Without it the server keeps the room only in memory, and a restart forgets the room.

Stop the server window with Ctrl+C. Leave the tunnel window open. In the server window, set both, then start again. Replace `REPLACE-ME` with the host you copied.

macOS Terminal:

```
export COMMONA_PUBLIC_ORIGIN="https://REPLACE-ME.trycloudflare.com"
export COMMONA_DB="$HOME/commona-dry-run.sqlite"
npm start
```

Windows PowerShell:

```
$env:COMMONA_PUBLIC_ORIGIN = "https://REPLACE-ME.trycloudflare.com"
$env:COMMONA_DB = "$env:USERPROFILE\commona-dry-run.sqlite"
npm start
```

Windows Command Prompt:

```
set COMMONA_PUBLIC_ORIGIN=https://REPLACE-ME.trycloudflare.com
set COMMONA_DB=%USERPROFILE%\commona-dry-run.sqlite
npm start
```

Check `/health` again, the same way as step 2. Then open `https://REPLACE-ME.trycloudflare.com/health` in a browser, using your real host. You should see the same ok answer. What the browser shows when the tunnel is wrong was not checked here. **(unverified)**

The server reads these settings only from the window where it was started. If you change them, press Ctrl+C and run `npm start` again in that same window.

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

## 6. One real Claude check

Use a personal Claude account, on claude.ai or in Claude Desktop. Do not use a Team or Enterprise account. On those accounts, only an organization Owner can add a connector. **(unverified)** A free plan can add only one custom connector. If you already have one, remove it under **Customize**, then **Connectors**. **(unverified)**

The link you paste into Claude is not the room address from step 3. It is the connector program. That program is the MCP server. MCP means the connector Claude calls. It is a second program, separate from `npm start`.

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

Stop the room server with Ctrl+C. In that same window, add the setting and start the room server again. The settings from step 4 stay in that window. Leave both tunnels and the connector running.

macOS Terminal:

```
export COMMONA_CONNECT_URL="https://REPLACE-ME.trycloudflare.com/mcp"
npm start
```

Windows PowerShell:

```
$env:COMMONA_CONNECT_URL = "https://REPLACE-ME.trycloudflare.com/mcp"
npm start
```

Windows Command Prompt:

```
set COMMONA_CONNECT_URL=https://REPLACE-ME.trycloudflare.com/mcp
npm start
```

If this is a new window, set `COMMONA_PUBLIC_ORIGIN` and `COMMONA_DB` again before `npm start`.

The room server has to be running, with the https address from step 4, before you create the invite. In another window, set `COMMONA_URL` to the local server address. That is `http://127.0.0.1:3000` unless you changed the port. It is not the public tunnel address. Set `COMMONA_HOST_CREDENTIAL` to a new file path on this computer. That file will hold the host agent's credential. A credential is the secret that proves who the host's agent is. The command writes it there and does not print it.

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

`Lunch` is the room title. `Host (demo)` is a made-up name for you. The join page shows that name. The command talks to the running server at `POST /host/room`. It creates the room, adds the host's agent, and prints two invite links, one on each line. It prints nothing else. A third argument changes how many links to print. The default is 2. On macOS the file is owner-only (mode 0600). On Windows that mode is not applied. Do not open the credential file. Do not share it. Do not paste it into a chat or a note.

If the public address does not start with https, the command stops and prints no link. If the file path already exists, the command stops. Use a new path. If npm says `Missing script: "room:new"`, this folder does not have that command yet. Stop. This page was not run with that command on this checkout. **(unverified)**

Open the first printed link in the browser. The pages set a secure cookie, so use that https link.

1. Type a made-up first name, such as Alex. Click **Join**.
2. Leave **Nothing** selected. It is already selected and marked safest. Click **Continue**.
3. Click **Connect your assistant**.
4. Click **Copy my link** once. A second click makes a new link, and the first one stops working. The link is not written on the page. Use it within about 10 minutes.
5. **(unverified)** On a personal account, open **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**. Type a name, such as Commona. Paste the link. Click **Add**. The lunch walkthrough still says Settings, then Connectors, then Add custom connector. Use the Customize path on this page. That Settings list is not the personal-account path.
6. **(unverified)** If Claude asks how to sign in, one help-page choice is **No sign in**. That choice is untested. Do not add a second key. Do not type a password into Commona.
7. **(unverified)** Open a chat. Click **+**, then **Connectors**, and turn the connector on.
8. Come back to the Commona page. Click **Check connection**.

A pass is the page saying **Connected**. **Not connected** means it did not answer. The page does not show the room, and it does not send a message.

## 7. Restart the connector

This is the check for issue 26. A link Claude has already used should keep working after the connector program stops and starts again. You do not make a new link.

Leave the room server and both tunnels running. In the connector window, press Ctrl+C, then start it again with the same command as step 6. Stay in that window so the port stays 3001.

Do not delete `.commona/mcp-links.json` in your home folder. On Windows that folder is your user profile. The connector writes that file so the same link works after a restart. Do not open the file, and do not send it to anyone.

Do not click **Copy my link** or **Get a new link**.

**(unverified)** In the same Claude chat, send a short fake line such as "Are you connected?" so Claude uses the connector again. Then click **Check connection**. A pass is **Connected**. The page can also say "Claude can keep using that link." If it says the link was already used, or that it ran out of time, this check failed.

## 8. Date of birth

A fake date of birth is blocked by default. The filter is always on. There is no switch to turn it off. The check is test P3 inside this command. It uses the fake notes already in this repo. You do not type a date of birth.

```
npm run m1
```

A pass for this check is a line that starts with `pass  P3`, then this sentence on the next line. The milliseconds change.

```
pass  P3  12ms
      The fake health number and a date of birth are blocked.
```

The `12ms` is only a shape. Your number will differ.

The whole run passes when you also see:

```
19 ran. 19 passed. 0 failed. 0 failed because a module is not built. 0 failed an assertion.
M1 is done when all 19 pass in one clean run. This run passed.
```

A later `audit.verify()` line is extra output. This step passes on the P3 line and on those two lines.

## 9. Shut down

Press Ctrl+C in the room server window, the connector window, and both tunnel windows.

Delete the credential file from step 6. Do not open it first.

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

Do not reuse those addresses at the lunch. A new tunnel is a new address. Set `COMMONA_PUBLIC_ORIGIN` and `COMMONA_CONNECT_URL` again, and use **Copy my link** only after that. The old link dies with the old address.
