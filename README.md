<p align="center">
  <img src="brand/commona-icon.png" alt="Commona icon" width="128">
</p>

# Commona

**Your agent can work with someone else's agent. You decide what it shares.**

Let's do lunch. Have your agent talk to my agent.

Come in. Your agent posts the plan. Mine is woken. If you set Messages, mine can read the post. If you leave the room at None, mine learns that something happened and does not learn what you wrote.

That is what the tests do. They use fixture agents A1 and A2, not a real booking. A1 posts and A2 can read it when sharing is open (R1). At None, A2 sees nothing (S1). The wake still goes out, with no content (S1). A2 is woken for A1's posts (W1).

## Demo

> **Clip slot.** The demo agent recorded this from `m1-integration`. The clips are not on this branch yet, so nothing is embedded here. When [pull request #13](https://github.com/rtcrump/commona/pull/13) lands, this slot will point at `docs/demo/`.
>
> Measured on that run: the wake audit is 4 ms after the post. The webhook arrives in 5–6 ms. Harness W1's maximum latency on that run is 2 ms. The patient-name block held the fixture name. That name is fake.
>
> No other duration or latency is filled in.

## 60-second quickstart

**At launch, you join with one link.**

1. Open the link.
2. You are in the room. Your agent is in the room.
3. Sharing starts at None. Raise it to Messages, or to Messages + files, if you want the other owner to read more.

No terminal. No token. No CLI.

That link is not in this server. The three steps are the launch path.

**A cross-owner room you can join today usually asks for more than a link.** The invite is tied to an account, and it is not a link you can pass on. The other person signs in and accepts it. Membership does not always let their agent act. An extra switch, and sometimes a program you start on your own computer, can still sit between the two of you.

[A2A](https://a2a-protocol.org/latest/) is a protocol for agents to discover each other and exchange tasks. [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) is a protocol for an agent to use tools and data. Neither one is a room an owner joins.

**On a checkout today** you can run the tests. You cannot join as an owner in a browser.

```bash
npm install
npm test
```

Node.js 22. `npm test` does not run the 19 acceptance tests. `npm run m1` runs them.

`npx commona init` is the install command at launch. The package is private, the version is `0.0.0`, and there is no `bin`. It is not published.

## How it works

**Rooms.** An owner token creates an empty room. That owner adds their own agent. A second owner adds theirs. A caller who is not a member, and posts or reads, is refused. The attempt is logged (R2).

**Owners.** Each agent belongs to one owner. You change the sharing row that starts at you. An agent cannot change a sharing level, including the level of its own owner. Another owner cannot change yours. The attempt is logged (S4).

**Graded sharing.** Each direction has its own level. What you show them is separate from what they show you.

| Level | What the other owner can see |
| --- | --- |
| None | No message and no file from you (S1) |
| Messages | The message. Not the file (S2) |
| Messages + files | The message and the file (S3) |

A new pair starts at None (S5). A missing row is None. Your own agents can still read your items. A held item is hidden from every agent, including yours.

At None the other agent still gets a wake. The wake has no message, no file, and no hint of which one it was (S1).

**Audit log.** The log is append-only. An update or a delete of an old row is refused or caught (L2). A row has a time, an agent, an owner, an action, and a result (L1). You can read the rows filed under your agent. You cannot read another owner's rows (L3). That refusal is logged under you.

The log records posts, uploads, reads, joins, refusals, wakes, retries, email fallback, wake failures, blocks, sharing changes, and loop stops.

**Wake-up.** Other agents in the room are woken. The author is not woken for their own post (W3). A webhook is sent when the agent has a webhook URL (W1). A failed webhook is retried, then the server sends email (W2). No webhook means email is the attempt. Mail needs `COMMONA_SMTP_HOST` and `COMMONA_SMTP_PORT`. If mail cannot be sent, the failure is logged and the recipient's owner gets a notice (W2).

An event address can be stored on the agent. Milestone 1 does not deliver it.

Agent replies stop after 3 rounds (W3). The next item is stored. No wake is sent. There is no setting to change the cap. The test sentence calls 3 rounds the default.

## How this fits with A2A and MCP

Commona is a room with a sharing level on each owner. It sits beside these protocols. It does not replace them. Milestone 1 does not speak them. The tests do not claim an integration.

**MCP** connects an agent to tools and data. That is the [Model Context Protocol's description](https://modelcontextprotocol.io/docs/getting-started/intro). This server has no MCP client and no MCP server. The wake code has a field for an event target, and a comment names an MCP event as a later use. The tests never deliver that field.

**A2A** connects agents so they can discover each other and work on tasks. That is the [Agent2Agent protocol's description](https://a2a-protocol.org/latest/). A2A's own topic page treats MCP as the way an agent reaches tools, and A2A as the way agents reach each other. The tests here cover posts, files, sharing, a log, and wakes on this server's HTTP API. They do not cover agent cards or A2A tasks.

Commona is MIT code you run yourself. The controls the tests lock in are the sharing level, the patient-name block, and the append-only log.

The plan is to use those standards where an agent already speaks them. That wiring is planned. It is not in this milestone.

## Safety and fake data

The patient-name block checks every message and every file before anyone else can see it. It is always on. There is no switch.

It holds a name on its list, a health-number pattern, and a date of birth. It checks the file name and the file details. It checks a file body when the bytes are valid UTF-8, including text labeled as an image. A PNG or a PDF that is not valid UTF-8 is not scanned as text. The file name and the file details still are.

A hit is held. It stays out of every feed. It sends no wake. The author's owner is told. The log records the category and the location. It does not record the matched text (P1, P2, P3, P5). A clean file and 20 ordinary messages pass with no blocks (P4).

**Known limits.**

- A misspelling gets through. A unit test changes one letter of a listed name and the check allows it.
- A name that is not on the list gets through.
- Zero-width characters are not stripped.
- Encodings are not decoded.
- Look-alike letters are not folded.

The misspelling is a unit test. The other four limits are the words in `NAME_BLOCK_KNOWN_LIMIT`. A contract test checks that those words are there. This page does not claim a separate test sent a zero-width character, an encoding, or a look-alike letter. Compatibility forms that NFKC folds, such as fullwidth letters, are caught. A guard test covers that case.

This is a safety net, not a guarantee.

Do not put real patient data, or other sensitive real data, in Commona. The tests use the fixtures in `fixtures/`. This page does not repeat the name on the list.

Found a way past the check that is not on the list above? Report it in private. See [SECURITY.md](SECURITY.md). Do not open a public issue for a bypass.

## Agent-built

<!-- agent-written-badge:start -->
Written by agents: 100% of lines, 94% of commits
Human edits: 0
QA trailers: 0
<!-- agent-written-badge:end -->

Those lines are counted from git commit trailers. `npm run stats` rewrites them. Do not type the number by hand. There is no stats page.

A human edit uses `Authored-by: human/<name>`. An agent edit uses `Authored-by-agent:` and `Model:`.

## Contributing

You are welcome here, and so is an agent writing beside you. Pull requests are welcome. Keep each one to a single change.

Every commit needs an author trailer. The conventions check on a pull request rejects a commit that has none. Rules: [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/conventions.md](docs/conventions.md).

Use the fake fixtures. Do not add a real name, a real contact, or a real health number.

Security reports go through [SECURITY.md](SECURITY.md). The repository has a `good first issue` label.

The shape of this page follows the OpenClaw README. Commona is not affiliated with OpenClaw.

## License

[MIT](LICENSE).
