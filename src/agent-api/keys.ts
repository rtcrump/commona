import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  hashToken,
  isId,
  ownerActorId,
  ReasonCode,
  type AuthPrincipal,
} from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { ensureAgentApiSchema } from "./schema.js";

/** True when this raw key was revoked. The lookup uses the SHA-256 hash. */
export function isRevokedAgentKey(deps: RoomDeps, presented: string): boolean {
  ensureAgentApiSchema(deps.db);
  if (!/^[A-Za-z0-9_-]+$/.test(presented)) return false;
  const row = deps.db
    .prepare("SELECT 1 AS ok FROM agent_key_revocations WHERE token_hash = ?")
    .get(hashToken(presented)) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * The room owner revokes one agent's current key.
 * The hash is kept so a later presentation is 401. The raw key is not stored.
 * agents.token_hash is cleared so the existing bearer lookup fails.
 */
export function revokeAgentKey(deps: RoomDeps, principal: AuthPrincipal, roomId: string, agentId: string): void {
  ensureAgentApiSchema(deps.db);
  if (!isId(roomId) || !isId(agentId)) throw RoomHttpError.notFound();
  const room = deps.db.prepare("SELECT created_by_owner_id FROM rooms WHERE id = ?").get(roomId) as
    | { created_by_owner_id: string }
    | undefined;
  if (!room) throw RoomHttpError.notFound();
  const actor = actorOf(principal);
  if (principal.ownerId !== room.created_by_owner_id) {
    refuse(deps, roomId, actor, agentId, ReasonCode.NotOwner);
  }
  const already = deps.db
    .prepare("SELECT token_hash FROM agent_key_revocations WHERE agent_id = ? AND room_id = ?")
    .get(agentId, roomId) as { token_hash: string } | undefined;
  if (already) return;
  const member = deps.db
    .prepare("SELECT agent_id FROM memberships WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agentId) as { agent_id: string } | undefined;
  const agent = deps.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agentId) as
    | { token_hash: string | null }
    | undefined;
  if (!member || !agent?.token_hash) {
    deps.audit.append({
      ts: formatTimestamp(deps.clock.now()),
      room: roomId,
      agentId: actor.agentId,
      ownerId: actor.ownerId,
      action: AuditAction.SettingChangeRefused,
      result: AuditResult.Refused,
      detail: { itemId: agentId },
    });
    throw RoomHttpError.notFound();
  }
  const tokenHash = agent.token_hash;
  const now = formatTimestamp(deps.clock.now());
  const write = deps.db.transaction(() => {
    deps.db
      .prepare(
        "INSERT INTO agent_key_revocations (agent_id, room_id, token_hash, revoked_at) VALUES (?, ?, ?, ?)",
      )
      .run(agentId, roomId, tokenHash, now);
    const cleared = deps.db
      .prepare("UPDATE agents SET token_hash = NULL WHERE id = ? AND token_hash = ?")
      .run(agentId, tokenHash);
    if (cleared.changes !== 1) throw RoomHttpError.notFound();
    deps.audit.append({
      ts: now,
      room: roomId,
      agentId: actor.agentId,
      ownerId: actor.ownerId,
      action: AuditAction.SettingChange,
      result: AuditResult.Ok,
      detail: { itemId: agentId },
    });
  });
  write.immediate();
}

function refuse(
  deps: RoomDeps,
  roomId: string,
  actor: { agentId: string; ownerId: string },
  agentId: string,
  reasonCode: typeof ReasonCode.NotOwner,
): never {
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: roomId,
    agentId: actor.agentId,
    ownerId: actor.ownerId,
    action: AuditAction.SettingChangeRefused,
    result: AuditResult.Refused,
    detail: { reasonCode, itemId: agentId },
  });
  throw RoomHttpError.forbidden(reasonCode);
}

function actorOf(principal: AuthPrincipal): { agentId: string; ownerId: string } {
  if (principal.kind === "agent") return { agentId: principal.agentId, ownerId: principal.ownerId };
  return { agentId: ownerActorId(principal.ownerId), ownerId: principal.ownerId };
}
