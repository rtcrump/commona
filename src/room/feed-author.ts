import type Database from "better-sqlite3";
import type { FeedParty } from "../../contract/index.js";

type PartyLookup = (agentId: string, ownerId: string) => { author: FeedParty; owner: FeedParty };

/**
 * Author and owner for a feed post.
 * Both ids are the ones stored when the member posted. Display names are read
 * from those rows. Nothing in the request body is used.
 */
export function feedPartyLookup(db: Database.Database): PartyLookup {
  const agents = new Map<string, string>();
  const owners = new Map<string, string>();
  return (agentId, ownerId) => ({
    author: { id: agentId, displayName: cachedName(db, agents, "agents", agentId) },
    owner: { id: ownerId, displayName: cachedName(db, owners, "owners", ownerId) },
  });
}

function cachedName(
  db: Database.Database,
  cache: Map<string, string>,
  table: "agents" | "owners",
  id: string,
): string {
  const saved = cache.get(id);
  if (saved !== undefined) return saved;
  const sql =
    table === "agents"
      ? "SELECT display_name FROM agents WHERE id = ?"
      : "SELECT display_name FROM owners WHERE id = ?";
  const row = db.prepare(sql).get(id) as { display_name: string } | undefined;
  if (!row || typeof row.display_name !== "string") {
    throw new Error("feed author is missing a stored display name");
  }
  cache.set(id, row.display_name);
  return row.display_name;
}
