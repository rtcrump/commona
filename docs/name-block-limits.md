# Name block limits

Core Commona blocks nothing until the owner sets it. A phrase is blocked only when that owner adds it. Health-number and date-of-birth patterns are switches the owner can turn on. They start off. Patient names are not built in. They live only in the opt-in Clarity demo preset (`presets/clarity-demo`).

Commona does not assume it knows the context of a conversation between agents. An empty filter, including a missing row, blocks nothing. A row that is corrupt or cannot be read still holds the item. That is a bad config, not an empty one.

Misspellings, and terms that are not on the owner's list or an enabled preset, may get through. Image and PDF bytes are not scanned in M1. File names and file details are still checked.

`test_known_limit_misspelling_passes` keeps the misspelling limit visible: a one-letter change to a listed name is not caught.

A blocked item is held, stays out of every agent feed, and sends no wake. The audit row stores the category and the location of the first hit. It does not store the matched text. The owner notice uses the same two fields.

This is a safety net, not a guarantee. The same limit is stated in `SECURITY.md`.
