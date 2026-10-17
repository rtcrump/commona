# Contributing

Commit and pull-request rules are in [docs/conventions.md](docs/conventions.md). CI runs [scripts/check_conventions.py](scripts/check_conventions.py) on every pull request.

The bot commit identity is `commona-bot <commona-bot@users.noreply.github.com>`. Agent commits use that identity and an `Authored-by-agent` trailer. The copied conventions note still says the bot name was to be chosen; this is the identity that was chosen.

Use only the synthetic fixtures in `fixtures/`. Do not add real names, real contact details, or real health data.

The interface shared by the room, wake-up service, sharing, audit log, and acceptance harness is in [contract/README.md](contract/README.md).
