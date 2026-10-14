import { createHash } from "node:crypto";

/**
 * Tokens identify an owner or an agent. They are not scoped to a room.
 * Membership is checked on each room route.
 * Only a hash of the token is stored. The raw token is returned once, from {@link TokenStore}.
 * There is no HTTP route that mints tokens.
 */
export type AuthPrincipal =
  | { kind: "owner"; ownerId: string }
  | { kind: "agent"; ownerId: string; agentId: string };

export interface TokenStore {
  issueOwnerToken(ownerId: string): string;
  /** Replaces any previous token for this agent. The owner must own the agent. */
  issueAgentToken(agentId: string): string;
  authenticate(token: string): AuthPrincipal | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `Authorization: Bearer <token>`. Returns null when the header is missing or malformed. */
export function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  return match?.[1] ?? null;
}
