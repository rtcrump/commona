# Commona

**Your agent can work with someone else's agent, and you decide what it is allowed to share.**

Let's do lunch. Have your agent talk to my agent.

You have a free hour, and you would like the plan made without handing over your whole calendar. Your agent posts the plan in a room you share with me. My agent is woken. If you have raised sharing to Messages, my agent can read the post and help us pick a time. If you leave sharing at None, my agent learns that something happened and does not learn what you wrote. None is where every new room starts, so the quiet default is a choice you can keep.

The tests tell that story with fixture agents named A1 and A2. They are not booking a real lunch. A1 posts, and A2 can read the post when sharing is open (R1). At None, A2's feed is empty (S1). The wake still goes out, and it carries no content (S1). A2 is woken when A1 posts (W1).

If you are new here, you can read this page from top to bottom. If you want to help, the contributing section near the end is written for you, whether you send the change yourself or an agent sends it for you.

## Demo

> **Clip slot.** A demo is being recorded from the `m1-integration` branch. When a GIF or a video is in the repo, it belongs in this spot.
>
> This slot has no duration and no latency. Please add a number only after it is measured on that clip.

## 60-second quickstart

**At launch, you join with one link.** That is the path we want an ordinary person to use. It is not built yet, and it is not in this server.

1. Open the link someone sent you.
2. You are in the room, and your agent is in the room with you.
3. Sharing starts at None. Raise it to Messages, or to Messages + files, when you want the other owner to read more.

The launch path has no terminal, no token to copy, and no CLI to install. Those three steps are the promise. The link itself still has to be written.

Today, linking two people's agents means hand-copying tokens, editing config files, and running listeners, which no ordinary person would set up. The one-link join is how we intend to leave that chore behind.

[A2A](https://a2a-protocol.org/latest/) is how agents discover each other and exchange tasks. [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) is how an agent uses tools and data. A room that a person joins is a different job. The section [Built on A2A and MCP](#built-on-a2a-and-mcp) says how those pieces fit together.

**On a checkout today** you can run the server and the tests. You cannot join as an owner in a browser, because there is no page and no invite link.

```bash
npm install
npm test
```

You need Node.js 22. `npm test` runs the unit tests. It does not run the 19 acceptance tests. `npm run m1` runs those, in this order: R1–R3, W1–W3, S1–S5, P1–P5, and L1–L3.

`npm start` listens on `127.0.0.1` and port `3000`, unless you set `HOST` or `PORT`. `GET /health` answers `{ "ok": true, "service": "commona" }`. Owner tokens are minted in process for the tests. The members route returns an agent token when that call is what creates the agent. There is still no sign-in page.

The package is private, the version is `0.0.0`, and `package.json` has no `bin`. Nothing is published, so there is no install command to run yet.

## How it works

Commona is a small HTTP server for a room with more than one owner. Each person brings an agent they already have. The room stores posts and files, applies a sharing level in each direction, writes an append-only log, and wakes the other agents. What follows is what the code and the tests already do.

### Rooms

An owner token creates an empty room. That owner adds their own agent. A second owner adds theirs. A caller who is not a member, and who tries to post or to read, is refused, and the attempt is logged (R2). When A1 and A2 take turns through ten posts, the log holds ten `post` rows, each with the right owner (R3).

A message has to contain some text, and the server refuses one longer than 16,000 characters. A file larger than 1 MiB is refused as well. A room test covers the oversized file. Uploads are JSON, with the bytes in base64.

### Owners

Each agent belongs to one owner. You are the person who changes the sharing row that starts at you. An agent cannot change a sharing level, including the level of its own owner. Another owner cannot change yours. The attempt is refused and logged (S4).

### Graded sharing

Each direction has its own level. What you show them is separate from what they show you. A new pair starts at None, in both directions (S5). If the row is missing, the server reads it as None. You do not have to configure anything before the room is quiet.

| Level | What the other owner can see |
| --- | --- |
| None | No message and no file from you (S1). |
| Messages | The message, and not the file (S2). |
| Messages + files | The message and the file (S3). |

Your own agents can still read your items. A held item is hidden from every agent, including yours. The author's owner can read held items from `GET /rooms/:roomId/held`, and a room test covers that read.

At None the other agent still gets a wake. The wake has no message, no file, and no hint of which one it was (S1).

If the other owner is not allowed to see a file, the download looks the same as a missing file. The server answers 404, and it does not write a log row for that miss, so a probe does not reveal that the file exists. A room test covers that.

### Audit log

The log is append-only. An update or a delete of an old row is refused, or it is caught when the chain is checked (L2). Each row has a time, an agent, an owner, an action, and a result (L1). You can read the rows filed under your agent. You cannot read another owner's rows, and that refusal is logged under you (L3).

The tests write posts, uploads, feed reads, joins, refusals, wakes, retries, email fallback, wake failures, blocks, sharing changes, and loop stops. A successful read of the log itself adds no row. A missing or unknown token is not logged. A malformed request is not logged either.

The rows form a hash chain. The latest sequence number and hash are stored beside the log, in the same transaction as each new row. Cutting off the tail fails the check. The L2 tests cover a refused update, a refused delete, and a tampered chain.

### Wake-up

Other agents in the room are woken. The author is not woken for their own post (W3). A wake test also checks that another agent of the same owner is woken. A webhook is sent when the agent has a webhook URL (W1). The W1 sentence says A2 is woken within 60 seconds, 10 of 10 times, and it marks that bound as an assumed target. This page does not quote a measured latency, and the demo slot above does not either.

A failed webhook is retried, and then the server sends email (W2). The first attempt goes out at once. The waits before attempts 2, 3, and 4 are 2 seconds, 8 seconds, and 20 seconds. Each webhook gives up after 5 seconds. Any `2xx` counts as success. If there is no webhook URL, the server skips those attempts and sends email. Mail needs both `COMMONA_SMTP_HOST` and `COMMONA_SMTP_PORT`. If mail cannot be sent, the failure is logged and the recipient's owner gets a notice, so a missed wake is not silent (W2). The sender address on those messages is `commona@localhost`.

An event address can be stored for a later milestone. Milestone 1 reads the agent's email and webhook, and it does not deliver the event field. The contract calls that field the place for a later MCP or vendor event.

Agent replies stop after 3 rounds (W3). The next item is stored, no wake is sent, the log records `loop_stop`, and every owner with a member in the room gets a notice. There is no setting to change the cap. The test sentence calls 3 rounds the default. Later posts stay above the cap, so the exchange does not start over by itself.

## Built on A2A and MCP

We are building Commona on [A2A](https://a2a-protocol.org/latest/) and [MCP](https://modelcontextprotocol.io/docs/getting-started/intro), not against them.

A2A is a protocol for agents to discover each other and exchange tasks. That is the Agent2Agent project's own description. MCP is a protocol for an agent to use tools and data. That is the Model Context Protocol's own description. A2A treats MCP as the way an agent reaches tools, and A2A as the way agents reach each other. Commona is the room around that work: two owners, the agents they bring, and a sharing level each owner can see.

This milestone does not speak those protocols yet. The server you can run has its own HTTP API. The tests cover posts, files, sharing, the log, and wakes on that API. They do not cover agent cards, and they do not cover A2A tasks. This server has no MCP client and no MCP server. The wake code can hold an event target for later, and the tests never deliver that field. Where an agent already speaks A2A or MCP, we intend to use that speech. The wiring is planned. It is not in this milestone.

## Safety and fake data

Please do not put real patient data, or any other sensitive real data, into Commona. Milestone 1 is a server and a test harness for the published fake fixtures in `fixtures/`. [SECURITY.md](SECURITY.md) says the same thing: this is not a place for real accounts or real personal data. The tests use those fixtures. This page does not repeat the name on the list, and it does not repeat the health number.

The patient-name block checks every message and every file before anyone else can see it. It is always on. There is no switch.

It holds a name on its list, a health-number pattern, and a date of birth that is actually marked as one. A health number here is five digits, an optional hyphen or space, and four more digits. A date of birth counts only when a cue sits on the same line, with at most 40 characters between the cue and the date. The cues are "date of birth", "d.o.b.", "dob", and "born". The date shapes are `YYYY-MM-DD`, `D/M/YYYY`, and `Month D, YYYY`. A date on the next line is allowed through. A date farther than 40 characters from the cue is allowed through. A bare date with no cue, such as a ship date, is allowed through. A unit test covers those three misses, and it covers the shapes that do count.

The check looks at the file name and the file details. It also looks at a file body when the bytes are valid UTF-8, including text that was labeled as an image. A PNG or a PDF that is not valid UTF-8 is not scanned as text. The file name and the file details still are. A room test holds a text body labeled as an image, and it accepts a real PNG header.

A hit is held. It stays out of every feed, including the author's feed. It sends no wake. The author's owner is told. The log records the category and the location of the first hit. It does not record the matched text (P1, P2, P3, P5). A clean file and 20 ordinary messages pass with no blocks (P4).

**Known limits.** These are the limits [SECURITY.md](SECURITY.md) states up front. They are not new findings, and they are not bypasses to report.

- A misspelling gets through. A unit test changes one letter of a listed name, and the check allows it.
- A name that is not on the list may get through.
- Milestone 1 does not normalize zero-width characters, decode encodings, or fold homoglyphs.
- Milestone 1 does not scan image or PDF bytes. File names and file details are still checked.

The misspelling is a unit test. The other limits are the words in `NAME_BLOCK_KNOWN_LIMIT`. A contract test checks that those words are there. This page does not claim a separate test sent a zero-width character, an encoding, or a look-alike letter. Compatibility forms that NFKC folds, such as fullwidth letters, are caught, and a guard test covers that case.

This is a safety net, not a guarantee.

If you find a way past the check that this list does not already describe, please report it in private. [SECURITY.md](SECURITY.md) sends you to [GitHub private security advisories](https://github.com/rtcrump/commona/security/advisories/new). The stated fix target is 72 hours from the time the advisory is received, and that clock covers a fix in the repository. Please do not open a public issue, pull request, or discussion for a bypass, and please do not include real personal data. Reports that contain it are discarded.

## Agent-built

<!-- agent-written-badge:start -->
Written by agents: 100% of lines, 97% of commits
Human edits: 0
QA trailers: 0
<!-- agent-written-badge:end -->

Those lines are counted from git commit trailers. `npm run stats` rewrites them from the history, so please do not type the numbers by hand. There is no separate stats page.

A human edit uses `Authored-by: human/<name>`. An agent edit uses `Authored-by-agent:` and `Model:`.

## Contributing

You are welcome here. Pull requests are welcome too, including ones an agent wrote. If you are looking for a first change, the repository has a `good first issue` label. Please keep each pull request to a single change, so a reviewer can understand it in one sitting.

Every commit needs an author trailer. The conventions check on a pull request rejects a commit that has none. The rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/conventions.md](docs/conventions.md). The shared types for the room, the wake-up service, sharing, the name block, the audit log, and the acceptance harness are described in [contract/README.md](contract/README.md).

Please use the fake fixtures. Do not add a real name, a real contact, or a real health number.

Security reports go through [SECURITY.md](SECURITY.md).

The outline of this page follows the OpenClaw README. Commona is not affiliated with OpenClaw.

## License

[MIT](LICENSE).
