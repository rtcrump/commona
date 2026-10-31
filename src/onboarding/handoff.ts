import type Database from "better-sqlite3";
import { formatTimestamp, hashToken, newId, type Clock, type TokenStore } from "../../contract/index.js";
import { agentKeyReissueBlocked } from "../agent-api/keys.js";
import { ensureInviteSchema } from "../join/schema.js";
import { newSecret } from "./account.js";

/** J3 exchanges this once. It is not an HTTP response. */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface HandoffDeps {
  db: Database.Database;
  clock: Clock;
  tokens: TokenStore;
}

export interface AgentHandoff {
  secret: string;
  expiresAt: string;
  agentId: string;
  ownerId: string;
}

interface HandoffRow {
  id: string;
  owner_id: string;
  agent_id: string;
  expires_at: string;
  used_at: string | null;
}

/**
 * Mint a short-lived single-use handoff for the owner's default agent.
 * The raw secret is returned to the caller and stored only as a SHA-256 hash.
 * A second call retires any handoff that has not been claimed.
 */
export function issueAgentHandoff(deps: HandoffDeps, ownerId: string): AgentHandoff {
  ensureInviteSchema(deps.db);
  const agent = deps.db.prepare("SELECT agent_id FROM owner_agents WHERE owner_id = ?").get(ownerId) as
    | { agent_id: string }
    | undefined;
  if (!agent) throw new Error("handoff unusable");
  const nowDate = deps.clock.now();
  const now = formatTimestamp(nowDate);
  const expiresAt = formatTimestamp(new Date(nowDate.getTime() + HANDOFF_TTL_MS));
  const secret = newSecret();
  const id = newId("handoff");
  const write = deps.db.transaction(() => {
    deps.db
      .prepare("UPDATE agent_handoffs SET used_at = ? WHERE owner_id = ? AND used_at IS NULL")
      .run(now, ownerId);
    deps.db
      .prepare(
        `INSERT INTO agent_handoffs (id, owner_id, agent_id, secret_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, ownerId, agent.agent_id, hashToken(secret), expiresAt, now);
  });
  write();
  return { secret, expiresAt, agentId: agent.agent_id, ownerId };
}

/**
 * Claim a handoff once. Returns a freshly issued agent credential.
 * Expired, unknown, and already-used handoffs fail the same way.
 */
export function claimAgentHandoff(
  deps: HandoffDeps,
  secret: string,
): { agentId: string; ownerId: string; credential: string } {
  ensureInviteSchema(deps.db);
  const now = formatTimestamp(deps.clock.now());
  const secretHash = hashToken(secret);
  const claim = deps.db.transaction(() => {
    const row = deps.db
      .prepare(
        "SELECT id, owner_id, agent_id, expires_at, used_at FROM agent_handoffs WHERE secret_hash = ?",
      )
      .get(secretHash) as HandoffRow | undefined;
    if (!row || row.used_at !== null || row.expires_at <= now) return null;
    if (agentKeyReissueBlocked(deps.db, row.agent_id)) return null;
    const updated = deps.db
      .prepare("UPDATE agent_handoffs SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, row.id, now);
    if (updated.changes !== 1) return null;
    const credential = deps.tokens.issueAgentToken(row.agent_id);
    return { agentId: row.agent_id, ownerId: row.owner_id, credential };
  });
  const result = claim.immediate();
  if (!result) throw new Error("handoff unusable");
  return result;
}
