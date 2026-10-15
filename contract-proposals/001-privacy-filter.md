# Proposal 001: Owner privacy filter

The contract has no route for an owner's filter. This proposal does not change `contract/`. The filter is stored and enforced. Owners change it through `createPrivacyFilter` until a route is added.

## Proposed route

`PUT /owners/:ownerId/privacy-filter`

Body:

```json
{
  "terms": ["example-term"],
  "patterns": { "health_number": true, "dob": true },
  "presets": ["clarity-demo"]
}
```

- Only that owner's owner token may write.
- An agent token is refused with `agent_cannot_change_sharing`, even when the agent belongs to that owner.
- Any other caller is refused with `not_owner`.
- A successful write appends `setting_change` / `ok` on that owner's audit log.
- A refusal appends `setting_change_refused` / `refused` on the caller's audit log.
- `GET /owners/:ownerId/privacy-filter` returns the same shape to that owner only.

A new owner starts with both pattern flags true, `terms: []`, and `presets: []`. A missing or unreadable row holds every post and upload from that owner. Omitting a pattern flag does not turn it off. Only `false` does.

`clarity-demo` is the only preset. It loads the invented names in `fixtures/names.txt`. It is off unless the owner lists it.

## Proposed SECURITY.md known limits

Replace the "Known limits of the name guard" section with:

```markdown
## Known limits of the privacy filter

These are limits of this version, stated up front. They are not new findings, and they are not bypasses to report.

- Misspellings, and names that are not on the owner's term list or an enabled preset, may get through.
- Decoding stops at two layers. A term wrapped more than twice in base64, URL encoding, or HTML entities may get through.
- Image and PDF bytes are not scanned. File names and file details are still checked.

The filter is a safety net, not a guarantee. A report counts when it gets protected fake data past the filter in a way this list does not already describe.
```

The old sentence that milestone 1 does not normalize zero-width characters, decode encodings, or fold homoglyphs would be removed. Those three are now checked, up to the decode depth above.
