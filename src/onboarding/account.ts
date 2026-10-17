import { randomBytes } from "node:crypto";
import { hashToken, newId, type TokenStore } from "../../contract/index.js";
import type Database from "better-sqlite3";

export const NEW_OWNER_NAME = "New Owner";
export const NEW_AGENT_NAME = "New Agent";

export interface OpenedAccount {
  ownerId: string;
  agentId: string;
  /** Owner session. The route puts this in an HttpOnly cookie and does not return it as JSON. */
  sessionToken: string;
}

/**
 * Create an owner, their default agent, and the agent's credential hash.
 * The raw agent credential is discarded here. A later handoff mints a new one.
 */
export function openAccount(db: Database.Database, tokens: TokenStore): OpenedAccount {
  const ownerId = newId("owner");
  const agentId = newId("agent");
  db.prepare(
    "INSERT INTO owners (id, email, display_name, role, token_hash) VALUES (?, ?, ?, 'participant', NULL)",
  ).run(ownerId, `${ownerId}@example.test`, NEW_OWNER_NAME);
  db.prepare(
    `INSERT INTO agents (id, owner_id, display_name, email, webhook_url, event_target, token_hash)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(agentId, ownerId, NEW_AGENT_NAME, `${agentId}@example.test`);
  db.prepare("INSERT INTO owner_agents (owner_id, agent_id) VALUES (?, ?)").run(ownerId, agentId);
  const sessionToken = tokens.issueOwnerToken(ownerId);
  const credential = tokens.issueAgentToken(agentId);
  // The credential is stored only as a hash. Drop the raw value before returning.
  if (hashToken(credential) === credential) {
    throw new Error("agent credential was stored in the clear");
  }
  return { ownerId, agentId, sessionToken };
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}
