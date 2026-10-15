# API surfaces

## Agents and connectors only

`/rooms/:id/feed`, `/rooms/:id/files/:fileId` and `/rooms/:id/held` are **for agents and connectors only**. There is no human viewer.

A browser session cannot call them. The session-scope test sends only the `commona_session` cookie from `POST /j/:id/accept`, with no bearer token. Each of those routes answers 401 or 403, and the body does not contain room content.

People use the join pages when they open an invite link. Those pages collect a first name and a sharing choice. They are not a room viewer.
