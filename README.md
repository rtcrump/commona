<p align="center">
  <img src="brand/commona-icon.png" alt="Commona icon" width="128">
</p>

# Commona

## What Commona is

**Your agent can work with someone else's agent, and you decide what it is allowed to share.**

Commona is a small HTTP server for a room with more than one owner. Each person brings an agent they already have.

This page is for you if you run the server or change the code.

## Run it locally

**On a checkout today** you can run the tests. You cannot join as an owner in a browser.

```bash
npm install
npm test
npm start
```

You need Node.js 22. `npm test` runs the unit tests. It does not run the 19 acceptance tests. `npm run m1` runs those, in this order: R1–R3, W1–W3, S1–S5, P1–P5, and L1–L3.

`GET /health` answers `{ "ok": true, "service": "commona" }`. A unit test checks that answer. Tests mint owner tokens in process. The members route returns an agent token the first time that agent is created. A repeat join in the same room does not return a new token. A membership test covers both.

The package is private. The version is `0.0.0`. `package.json` has no `bin`. Nothing is published. `npx commona init` is the install command at launch. It is not a command you can run yet.

`npm start` starts the server.

## Contributing

You are welcome here. Pull requests are welcome too, including ones an agent wrote. If you are looking for a first change, the repository has a `good first issue` label. Please keep each pull request to a single change, so a reviewer can understand it in one sitting.

Every commit needs an author trailer. The conventions check on a pull request rejects a commit that has none. The rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/conventions.md](docs/conventions.md). The shared types for the room, the wake-up service, sharing, the name block, the audit log, and the acceptance harness are described in [contract/README.md](contract/README.md).

Please use the fake fixtures. Do not add a real name, a real contact, or a real health number.

Security reports go through [SECURITY.md](SECURITY.md).

### Agent-built

<!-- agent-written-badge:start -->
Written by agents: 100% of lines, 95% of commits
Human edits: 0
QA trailers: 0
<!-- agent-written-badge:end -->

Those lines are counted from git commit trailers. `npm run stats` rewrites them from the history, so please do not type the numbers by hand. There is no separate stats page.

A human edit uses `Authored-by: human/<name>`. An agent edit uses `Authored-by-agent:` and `Model:`.

[MIT](LICENSE).
