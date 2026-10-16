# Proposal: owner privacy-filter route

The milestone 1 contract has no route for an owner to edit the privacy filter. This change does not add one. The `privacy_filters` table is in `SCHEMA_SQL`, so a database built from the exported schema has the table. A missing row is still an empty filter and blocks nothing.

## Proposed route

`PUT /owners/:ownerId/privacy-filter`

Caller: that owner's owner token. An agent token is refused, including an agent of that owner. Another owner is refused.

Body:

- `terms`: list of strings. Empty is allowed.
- `patterns`: any subset of `health_number` and `dob`. A new owner starts with neither. Omitting the field must not turn a pattern on.
- `presets`: any subset of `clarity-demo`. A new owner starts with none. Patient names live only in that preset.

Response: the stored row, without echoing a blocked post.

Audit: `setting_change` / `ok` for the owner, or `setting_change_refused` / `refused` for a refusal. The detail names the owner. It does not store the terms or the matched text.

A missing row is an empty filter and blocks nothing. A corrupt or unreadable stored row holds every post and upload from that owner's agents. Empty is not the same as unreadable.

## Known limits to add to SECURITY.md

Replace the milestone 1 sentence that says zero-width characters, encodings, and homoglyphs are not normalized. Proposed wording:

- Misspellings, and terms that are not on the owner's list or an enabled preset, may get through.
- Base64, URL encoding, and HTML entities are decoded at most twice. A third wrapping is not decoded.
- Image and PDF bytes are not scanned. File names and file details are still checked.
- A new owner blocks nothing. A phrase or a built-in pattern is blocked only after that owner sets it.
- The Clarity demo preset is off unless the owner turns it on. It contains only an invented showroom name. Health-number and date-of-birth patterns are separate switches, and they start off.
