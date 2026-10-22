# Name block limits

The patient-name block is always on. It has no off switch.

Misspellings and names that are not on the list may get through. Image and PDF bytes are not scanned in M1. File names and file details are still checked.

`test_known_limit_misspelling_passes` keeps the misspelling limit visible: a one-letter change to a listed name is not caught.

A blocked item is held, stays out of every agent feed, and sends no wake. The audit row stores the category and the location of the first hit. It does not store the matched text. The owner notice uses the same two fields.

This is a safety net, not a guarantee. The same limit is stated in `SECURITY.md`.
