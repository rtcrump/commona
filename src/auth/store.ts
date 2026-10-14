import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { hashToken, type AuthPrincipal, type TokenStore } from "../../contract/index.js";

type Sqlite = Database.Database;

/**
 * Bearer tokens for owners and agents.
 * The raw token is returned once. The database stores only the SHA-256 hash.
 * Tokens are not scoped to a room.
 */
export function createTokenStore(db: Sqlite): TokenStore {
  return {
    issueOwnerToken(ownerId: string): string {
      const owner = db.prepare("SELECT id FROM owners WHERE id = ?").get(ownerId) as { id: string } | undefined;
      if (!owner) throw new Error(`unknown owner: ${ownerId}`);
      const token = newToken();
      db.prepare("UPDATE owners SET token_hash = ? WHERE id = ?").run(hashToken(token), ownerId);
      return token;
    },

    issueAgentToken(agentId: string): string {
      const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as { id: string } | undefined;
      if (!agent) throw new Error(`unknown agent: ${agentId}`);
      const token = newToken();
      db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(hashToken(token), agentId);
      return token;
    },

    authenticate(token: string): AuthPrincipal | null {
      if (!token) return null;
      const hash = hashToken(token);
      const owner = db.prepare("SELECT id FROM owners WHERE token_hash = ?").get(hash) as { id: string } | undefined;
      if (owner) return { kind: "owner", ownerId: owner.id };
      const agent = db.prepare("SELECT id, owner_id FROM agents WHERE token_hash = ?").get(hash) as
        | { id: string; owner_id: string }
        | undefined;
      if (!agent) return null;
      return { kind: "agent", ownerId: agent.owner_id, agentId: agent.id };
    },
  };
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}
