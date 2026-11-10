# Commona

Commona is a shared workspace for people whose AI assistants need to work together, with each person deciding what to share.

**Live demo:** not live yet. The public hostname is still waiting for approval, so this address is only a placeholder, and the repository homepage should use that same approved address once it exists: <https://pending-public-hostname.invalid>

![Scripted Commona demo with fake data and no account. Two fictional assistants plan a short walk. Sharing stays closed until Nia approves messages with Sol and Sol approves messages with Nia. The walk is then agreed for Saturday at 10:00 at the east park gate.](docs/images/public-demo.png)

[![CI on main](https://github.com/rtcrump/commona/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rtcrump/commona/actions/workflows/ci.yml)

This is a scripted replay with fictional people. No model is answering, and this is not a live conversation. You do not need an account. The story is the same for every visitor.

## How it's built

I write the specs and review every change. AI coding agents (Cursor cloud agents, Grok Build, Codex, and Claude Code) implement the work through pull requests. Each pull request is checked by automated Codex review, CI, and a Claude safety review. Nothing is merged until I approve it.

## Try the story on your own machine

You can read the same fake-data story on your computer. It does not deploy, and it does not open a private room.

```bash
npm install
npm run demo
```

You need Node.js 22.5.0 or newer. Open the address the command prints. The package stays private at version `0.1.0`. Nothing is published to npm.

`npm test` runs the Node tests and the Worker tests.

## Contributing

You are welcome here. Pull requests are welcome too, including ones an agent wrote. If you are looking for a first change, the repository has a `good first issue` label. Please keep each pull request to a single change, so a reviewer can understand it in one sitting.

Every commit needs an author trailer. The conventions check on a pull request rejects a commit that has none. The rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/conventions.md](docs/conventions.md). The shared types for the room, the wake-up service, sharing, the audit log, and the acceptance harness are described in [contract/README.md](contract/README.md).

Please use the fake fixtures. Do not add a real name, a real contact, or a real health number.

Security reports go through [SECURITY.md](SECURITY.md). Notes for this version are in [docs/release-notes/v0.1.0.md](docs/release-notes/v0.1.0.md).

### Agent-built

<!-- agent-written-badge:start -->
Written by agents: 86% of lines, 97% of commits
Human edits: 0
QA trailers: 1
<!-- agent-written-badge:end -->

Those lines are counted from git commit trailers. `npm run stats -- --pending-kind agent` rewrites them from the history, including the commit that updates this badge, and repeats until the numbers settle. Use `human` for an `Authored-by: human/...` commit or `unattributed` for a commit without authorship trailers. Please do not type the numbers by hand. There is no separate stats page.

A human edit uses `Authored-by: human/<name>`. Several of those trailers, and no agent trailer, still count as one human edit. An agent edit uses `Authored-by-agent:` and `Model:`. A GitHub squash whose footer after the divider credits a person in `Co-authored-by` is not counted as agent-written. The divider is an exact, unindented line of nine hyphens, and it counts only when every line after it is an allowed trailer, such as `Co-authored-by`, `QA`, or `Approved-by`. Body text after it does not count. A person credited inside a squashed commit is not that footer.

[MIT](LICENSE).
