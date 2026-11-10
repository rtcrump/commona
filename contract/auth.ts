import { createHash } from "node:crypto";
import { ownerActorId } from "./ids.js";

/**
 * Tokens identify an owner, an agent, or a narrow sharing key. They are not scoped to a room.
 * Membership is checked on each room route.
 * Only a hash of the token is stored. The raw token is returned once, from {@link TokenStore}.
 * There is no HTTP route that mints tokens.
 * A narrow key is not an owner token. It can only lower its own outbound sharing from messages to none.
 */
export type AuthPrincipal =
  | { kind: "owner"; ownerId: string }
  | { kind: "agent"; ownerId: string; agentId: string }
  | { kind: "narrow"; ownerId: string };

/** Audit actor for a narrow sharing key. It is not `owner:<id>`. */
export const NARROW_SHARING_ACTOR = "narrow";

export function principalActor(principal: AuthPrincipal): { agentId: string; ownerId: string } {
  if (principal.kind === "agent") return { agentId: principal.agentId, ownerId: principal.ownerId };
  if (principal.kind === "narrow") return { agentId: NARROW_SHARING_ACTOR, ownerId: principal.ownerId };
  return { agentId: ownerActorId(principal.ownerId), ownerId: principal.ownerId };
}

export interface TokenStore {
  issueOwnerToken(ownerId: string): string;
  /** Replaces any previous token for this agent. The owner must own the agent. */
  issueAgentToken(agentId: string): string;
  /**
   * Replaces any previous narrow key for this owner.
   * Does not change `owners.token_hash`. The raw key is returned once.
   */
  issueNarrowToken(ownerId: string): string;
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
