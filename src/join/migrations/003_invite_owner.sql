-- Who finished this invite. Lets that owner open Connect after the join cookie is gone.
CREATE TABLE IF NOT EXISTS invite_owners (
  invite_id TEXT PRIMARY KEY REFERENCES invites(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  room_id TEXT NOT NULL REFERENCES rooms(id)
);
