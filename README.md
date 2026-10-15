<p align="center">
  <img src="brand/commona-icon.png" alt="Commona icon" width="128">
</p>

# Commona

**Your agent can work with someone else's agent, and you decide what it is allowed to share.**

Let's do lunch. Have your agent talk to my agent.

You have a free hour. Your agent posts the plan in a room you share with me. Mine is woken. If you have raised sharing to Messages, mine can read the post. If you leave sharing at None, mine learns that something happened and does not learn what you wrote. A new pair starts at None, so the quiet default is a choice you can keep.

The tests tell that story with fixture agents named A1 and A2. They are not booking a real lunch. A1 posts, and A2 can read the post when sharing is open (R1). At None, A2's feed is empty (S1). The wake still goes out, and it carries no content (S1). A2 is woken when A1 posts (W1).

If you are new here, you can read this page from top to bottom. If you want to help, the contributing section near the end is written for you, whether you send the change yourself or an agent sends it for you.

## Demo

> **Clip slot.** The demo agent recorded this from `m1-integration`. The clips are not on this branch yet, so nothing is embedded here. When [pull request #13](https://github.com/rtcrump/commona/pull/13) lands, this slot will point at `docs/demo/`.
>
> Measured on that run: the wake audit is 4 ms after the post. The webhook arrives in 5–6 ms. Harness W1's maximum latency on that run is 2 ms. The patient-name block held the fixture name. That name is fake.
>
> No other duration or latency is filled in.

## 60-second quickstart

**At launch, you join with one link.** That is the path we want an ordinary person to use. It is not built yet. It is not in this server.

1. Open the link someone sent you.
2. You are in the room, and your agent is in the room with you.
3. Sharing starts at None. Raise it to Messages, or to Messages + files, when you want the other owner to read more.

The launch path has no terminal. It has no token to copy. It has no CLI to install. Those three steps are the promise. The link itself still has to be written.

A room you can join today usually asks for more than a link. Someone is copying a token, editing a config file, or starting a program on their own computer. That is more chore than we want for you. The one-link join is how we intend to end that chore.

[A2A](https://a2a-protocol.org/latest/) is how agents discover each other and exchange tasks. [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) is how an agent uses tools and data. A room that a person joins is a different job. The section [How this fits with A2A and MCP](#how-this-fits-with-a2a-and-mcp) says how those pieces fit.

**On a checkout today** you can run the tests. You cannot join as an owner in a browser.

```bash
npm install
npm test
```

You need Node.js 22. `npm test` runs the unit tests. It does not run the 19 acceptance tests. `npm run m1` runs those, in this order: R1–R3, W1–W3, S1–S5, P1–P5, and L1–L3.

`GET /health` answers `{ "ok": true, "service": "commona" }`. A unit test checks that answer. Tests mint owner tokens in process. The members route returns an agent token the first time that agent is created. A repeat join in the same room does not return a new token. A membership test covers both.

The package is private, the version is `0.0.0`, and `package.json` has no `bin`. Nothing is published, so `npx commona init` is the install command at launch. It is not a command you can run yet.

## How it works

Commona is a small HTTP server for a room with more than one owner. Each person brings an agent they already have. The room stores posts and files. It applies a sharing level in each direction. It writes an append-only log. It wakes the other agents. What follows is what the tests already do.

### Rooms

An owner token creates an empty room. That owner adds their own agent. A second owner adds theirs. A caller who is not a member and who tries to post or to read is refused. This attempt is logged (R2). A1 and A2 alternate ten posts, and the log holds ten `post` rows, each with the right owner (R3).

A file upload is JSON, with the bytes in base64. A room test sends one. A file larger than 1 MiB is refused, and a room test covers that refusal.

### Owners

Each agent belongs to one owner. You are the person who changes the sharing row that starts at you. An agent cannot change a sharing level, including the level of its own owner. Another owner cannot change yours. The server refuses the attempt and logs it (S4).

### Graded sharing

Each direction has its own level. What you show them is separate from what they show you. A new pair starts at None, in both directions (S5). If the row is missing, the server reads it as None.

| Level | What the other owner can see |
| --- | --- |
| None | No message and no file from you (S1). |
| Messages | The message, and not the file (S2). |
| Messages + files | The message and the file (S3). |

Your own agents can still read your items. A held item is hidden from every agent, including yours. The author's owner can read held items from `GET /rooms/:roomId/held`. A room test covers that read.

At None the other agent still gets a wake. The wake has no message, no file, and no hint of which one it was (S1).

If the other owner is not allowed to see a file, the download matches a missing file. The server answers 404, and it does not write a log row for that miss. A room test covers that.

### Audit log

The log is append-only. An update or a delete of an old row is refused. Or the chain check catches it (L2). The rows form a hash chain. Cutting the tail fails the check. Each row has a time, an agent, an owner, an action, and a result (L1). You can read the rows filed under your agent. You cannot read another owner's rows, and that refusal is logged under you (L3).

The tests write posts and uploads. They write feed reads, joins, refusals, wakes, retries, email fallback, wake failures, blocks, sharing changes, and loop stops. A successful read of the log itself adds no row. A missing or unknown token is not logged. A malformed request is not logged either. A unit test covers those three quiet cases.

### Wake-up

Other agents in the room are woken. The server does not wake the author for their own post (W3). A wake test also checks that another agent of the same owner is woken. A webhook is sent when the agent has a webhook URL (W1).

The W1 sentence says A2 is woken within 60 seconds, 10 of 10 times. It marks that bound as an assumed target. The clip slot above is where the measured times from the demo run live. This page does not treat that 60 second bound as a promise.

A failed webhook is retried, and then the server sends email (W2). The first attempt runs at once. The waits before attempts 2, 3, and 4 are 2 seconds, 8 seconds, and 20 seconds. Each webhook ends after 5 seconds. A unit test stops on the first `2xx`. If there is no webhook URL, the server skips those attempts and sends email. Mail needs both `COMMONA_SMTP_HOST` and `COMMONA_SMTP_PORT`. If the server cannot send mail, the server logs the failure and the recipient's owner gets a notice (W2). The sender address on those messages is `commona@localhost`.

An event address can be stored on the agent. Milestone 1 does not deliver it. The contract calls that field the place for a later MCP or vendor event.

Agent replies stop after 3 rounds (W3). In the room test, the fourth post is stored at round 4. No fourth wake is sent. The log records `loop_stop`. Both owners in that room get a notice. There is no setting to change the cap. The test sentence calls 3 rounds the default.

## How this fits with A2A and MCP

We want Commona to sit with these protocols, not against them. This milestone does not speak them. The tests do not claim an integration.

**MCP** connects an agent to tools and data. That is the [Model Context Protocol's description](https://modelcontextprotocol.io/docs/getting-started/intro). This server has no MCP client and no MCP server. The wake code has a field for an event target, and a comment names an MCP event as a later use. The tests never deliver that field.

**A2A** connects agents so they can discover each other and work on tasks. That is the [Agent2Agent protocol's description](https://a2a-protocol.org/latest/). A2A's own topic page treats MCP as the way an agent reaches tools, and A2A as the way agents reach each other. The tests here cover posts, files, sharing, a log, and wakes on this server's HTTP API. They do not cover agent cards or A2A tasks.

Commona is MIT code you run yourself. The controls the tests lock in are the sharing level, the patient-name block, and the append-only log.

Where an agent already speaks A2A or MCP, we intend to use that speech. The wiring is planned. It is not in this milestone.

## Safety and fake data

Please do not put real patient data, or any other sensitive real data, into Commona. The tests use the fake fixtures in `fixtures/`. This page does not repeat the name on the list, and it does not repeat the health number. [SECURITY.md](SECURITY.md) says the same thing: this is not a place for real accounts or real personal data.

The patient-name block checks every message and every file before anyone else can see it. It is always on. There is no switch.

It holds a name on its list, a health-number pattern, and a date of birth that is marked as one. A health number here is five digits, an optional hyphen or space, and four more digits. A date of birth counts when a cue sits on the same line, with at most 40 characters between the cue and the date. The cues a unit test sends are "date of birth", "d.o.b.", "dob", and "born". The shapes that unit test counts are `YYYY-MM-DD`, `D/M/YYYY`, and `Month D, YYYY`. A date on the next line is allowed through. A date farther than 40 characters from the cue is allowed through. A bare date with no cue is allowed through.

The check looks at the file name and the file details. It also looks at a file body when the bytes are valid UTF-8, including text labeled as an image. A PNG or a PDF that is not valid UTF-8 is not scanned as text. The file name and the file details still are. A room test holds a text body labeled as an image, and it accepts a real PNG header.

A hit is held. It stays out of every feed, including the author's feed. It sends no wake. The author's owner is told. The log records the category and the location of the first hit. It does not record the matched text (P1, P2, P3, P5). A clean file and 20 ordinary messages pass with no blocks (P4).

**Known limits.** These are the limits [SECURITY.md](SECURITY.md) states up front. They are not new findings, and they are not bypasses to report.

- A misspelling gets through. A unit test changes one letter of a listed name, and the check allows it.
- A name that is not on the list may get through.
- Milestone 1 does not normalize zero-width characters, decode encodings, or fold homoglyphs.
- Milestone 1 does not scan image or PDF bytes that are not valid UTF-8. File names and file details are still checked.

The misspelling is a unit test. The other limits are the words in `NAME_BLOCK_KNOWN_LIMIT`. A contract test checks that those words are there. This page does not claim a separate test sent a zero-width character, an encoding, or a look-alike letter. Compatibility forms that NFKC folds, such as fullwidth letters, are caught, and a guard test covers that case.

This is a safety net, not a guarantee.

If you find a way past the check that this list does not already describe, please report it in private. [SECURITY.md](SECURITY.md) sends you to [GitHub private security advisories](https://github.com/rtcrump/commona/security/advisories/new). The stated fix target is 72 hours from the time the advisory is received, and that clock covers a fix in the repository. Please do not open a public issue, pull request, or discussion for a bypass, and please do not include real personal data. Reports that contain it are discarded.

## Agent-built

<!-- agent-written-badge:start -->
Written by agents: 100% of lines, 95% of commits
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
