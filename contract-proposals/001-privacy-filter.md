# Proposal: owner privacy-filter route

The milestone 1 contract has no route for an owner to edit the privacy filter. This change does not add one, and it does not edit `contract/`.

## Proposed route

`PUT /owners/:ownerId/privacy-filter`

Caller: that owner's owner token. An agent token is refused, including an agent of that owner. Another owner is refused.

Body:

- `terms`: list of strings. Empty is allowed.
- `patterns`: any subset of `health_number` and `dob`. A new owner starts with both on. Omitting the field must not turn a pattern off.
- `presets`: any subset of `clarity-demo`. A new owner starts with none.

Response: the stored row, without echoing a blocked post.

Audit: `setting_change` / `ok` for the owner, or `setting_change_refused` / `refused` for a refusal. The detail names the owner. It does not store the terms or the matched text.

A missing or unreadable stored row holds every post and upload from that owner's agents. It does not mean "patterns off".

## Known limits to add to SECURITY.md

Replace the milestone 1 sentence that says zero-width characters, encodings, and homoglyphs are not normalized. Proposed wording:

- Misspellings, and terms that are not on the owner's list or an enabled preset, may get through.
- Base64, URL encoding, and HTML entities are decoded at most twice. A third wrapping is not decoded.
- Image and PDF bytes are not scanned. File names and file details are still checked.
- The Clarity demo preset is off unless the owner turns it on. It contains only an invented showroom name.
