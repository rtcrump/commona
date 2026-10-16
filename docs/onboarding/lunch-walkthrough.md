# Lunch walkthrough

This is the real test, for a person to run later with Trafford and two friends. The rehearsal on this computer is `npm run demo:lunch`. That rehearsal uses the fake owners Orla (demo), Pim (demo), and Tavi (demo). It is not the real test.

The assistants agree a lunch. Each person hears the day, the time, and the place from their own assistant. The Commona pages stay on join and connect.

Times below are estimates for someone doing this the first time. The Claude taps are marked unverified, the same way as [Add your assistant in Claude](connect-claude.md).

## Before anyone starts

Trafford has these gates. The real test waits until he clears them.

- **Gate for Trafford.** A hosted address that starts with https. A link that only works on one computer will not do. Claude has to reach it. **(unverified)**
- **Gate for Trafford.** Which Claude plan can add a custom connector. The Claude help page names free, Pro, Max, Team, and Enterprise, and says a free account can add one. Nobody has tried this on a real Claude account. **(unverified)**
- **Gate for Trafford.** The exact Claude menus on a personal account. The page says Customize, then Connectors, then + Add, then Add custom connector. That path is marked unverified. A Team account uses a different path, and this walkthrough does not use it. **(unverified)**
- **Gate for Trafford.** Whether Claude accepts this link with no extra sign-in, and whether it keeps the whole link, including the part after the question mark. **(unverified)**

Each friend needs a Claude account and one invite link. One link is for one person. It works once.

## What Trafford does

About 2 minutes.

1. Start Commona on this computer and leave it running. Set `COMMONA_DB` to the database file and `COMMONA_PUBLIC_ORIGIN` to the hosted address. That address has to start with https. The public server listens on this computer, at `http://127.0.0.1:3000` unless the port was changed. Point the public tunnel at that port only. Starting Commona also opens a host command that listens only on this computer, at `http://127.0.0.1:3002` unless `COMMONA_HOST_PORT` was changed. Do not point the tunnel at that port. The public address does not serve the host command. Startup writes a one-time secret to `~/.commona/host-secret`. Set `COMMONA_HOST_SECRET_FILE` to use a different file. The secret file is owner-only. It is not printed. On Windows, the owner-only file mode is not applied.
2. In another terminal, set `COMMONA_URL` to the host command address, `http://127.0.0.1:3002`, not the public port. If you changed `COMMONA_HOST_PORT`, use that port. If you set `COMMONA_HOST_SECRET_FILE` when you started Commona, set the same path here. Set `COMMONA_HOST_CREDENTIAL` to a new file path on this computer. Run `npm run room:new -- Lunch "Host (demo)"`. The command reads the secret file and talks to the host command. It creates the room, names it Lunch, adds the host's agent, and prints two invite links, one on each line. It prints nothing else. The host agent's credential is written to that file and is not printed. On Windows, the owner-only file mode is not applied. A third argument changes how many links to print. The default is 2. Use a made-up host display name. The join page shows that name. If the hosted address does not start with https, the command stops and prints no link.
3. Send one link to the first friend, and the other link to the second friend. Send them in a way the friend already uses, such as a text message.

Trafford does not ask either friend to read a room page. There is no page for the lunch plan, and there is no pinned message.

## What each friend does

About 5 minutes for each friend. The taps are the ones on the join pages and the connect page.

1. **Open the link.** About 1 minute. The page names the host from the room:new command and the room Lunch. Type a first name. Tap **Join**.
2. **Choose Messages.** About 1 minute. The choices are Nothing, Messages, and Messages and files. Nothing is already selected and is marked safest. Tap **Messages**. Tap **Continue**.
3. **You're in.** About 30 seconds. Tap **Connect your assistant**.
4. **Copy the link.** About 30 seconds. Tap **Copy my link** once. A second tap makes a new link, and the first one stops working. The link is not written on the page. It lasts about 10 minutes.
5. **Paste it into Claude.** About 2 minutes. **(unverified)** On a personal account, open **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**, and paste. The page shows that path as a short picture of a screen. That connector is marked unverified. Tap **Add** in Claude.
6. **Check.** About 30 seconds. Come back to the Commona page. Tap **Check connection**. The page says **Connected** or **Not connected**. That is the whole answer. It does not show the lunch.

If the friend does not use Claude, they tell Trafford. The page says the same thing.

## What success looks like

Each friend's assistant, and Trafford's assistant, names the same day, the same time, and the same place. The person hears that from their assistant.

Count the taps. A friend who follows the page uses Join, Continue, Connect your assistant, Copy my link, the Claude paste and Add, and Check connection.

## What to watch for

- Where they pause, and which word they ask about. Sharing is the usual one: Nothing, Messages, Messages and files.
- Whether they tap Copy my link more than once.
- How many minutes from opening the link to the page saying Connected.
- Whether the Claude screens match the picture on our page.
- Whether the three assistants name one lunch, or three different ones.

## Observation form

Copy one block per person.

```
Person:
Steps taken:
Minutes:
Stuck points:
Quotes:
Page said Connected:
Assistant named this lunch:
```

Bring the forms back to Trafford with the three lunch lines side by side.
