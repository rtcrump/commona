-- Which room a connect link was issued for. The handoff secret stays a hash on agent_handoffs.
CREATE TABLE IF NOT EXISTS connect_links (
  handoff_id TEXT PRIMARY KEY REFERENCES agent_handoffs(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  invite_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The agent's own check-in. Not a room post.
CREATE TABLE IF NOT EXISTS connect_presence (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  checked_in_at TEXT NOT NULL
);

-- A Check connection click waits for the agent to answer one of these.
CREATE TABLE IF NOT EXISTS connect_pings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  requested_at TEXT NOT NULL,
  answered_at TEXT
);
