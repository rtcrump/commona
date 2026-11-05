import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  hashToken,
  isId,
  principalActor,
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
 * True when this agent must not receive a new key.
 * A revoked membership blocks reissue in every room, because the key is not room-scoped.
 * The room owner sending a new invite clears that block. Old hashes stay revoked.
 */
export function agentKeyReissueBlocked(db: RoomDeps["db"], agentId: string): boolean {
  ensureAgentApiSchema(db);
  const row = db
    .prepare("SELECT 1 AS ok FROM agent_key_revocations WHERE agent_id = ? AND blocks_reissue = 1")
    .get(agentId) as { ok: number } | undefined;
  return row !== undefined;
}

/** The room owner's new invite lifts the reissue block. Previously revoked keys stay 401. */
export function clearRoomReissueBlock(db: RoomDeps["db"], roomId: string): void {
  ensureAgentApiSchema(db);
  db.prepare("UPDATE agent_key_revocations SET blocks_reissue = 0 WHERE room_id = ?").run(roomId);
}

/**
 * The room owner revokes one agent's current key.
 * Every hash is kept, including a key issued after an earlier revoke.
 * agents.token_hash is cleared so the existing bearer lookup fails.
 * A repeat still clears the current hash and writes another audit entry.
 */
export function revokeAgentKey(deps: RoomDeps, principal: AuthPrincipal, roomId: string, agentId: string): void {
  ensureAgentApiSchema(deps.db);
  if (!isId(roomId) || !isId(agentId)) throw RoomHttpError.notFound();
  const room = deps.db.prepare("SELECT created_by_owner_id FROM rooms WHERE id = ?").get(roomId) as
    | { created_by_owner_id: string }
    | undefined;
  if (!room) throw RoomHttpError.notFound();
  const actor = principalActor(principal);
  if (principal.kind === "narrow") {
    refuse(deps, roomId, actor, agentId, ReasonCode.NotOwner);
  }
  if (principal.ownerId !== room.created_by_owner_id) {
    refuse(deps, roomId, actor, agentId, ReasonCode.NotOwner);
  }
  const member = deps.db
    .prepare("SELECT agent_id FROM memberships WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agentId) as { agent_id: string } | undefined;
  const agent = deps.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agentId) as
    | { token_hash: string | null }
    | undefined;
  const prior = deps.db
    .prepare("SELECT 1 AS ok FROM agent_key_revocations WHERE agent_id = ? AND room_id = ?")
    .get(agentId, roomId) as { ok: number } | undefined;
  if (!member || !agent || (!agent.token_hash && !prior)) {
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
    if (tokenHash) {
      deps.db
        .prepare(
          `INSERT INTO agent_key_revocations (token_hash, agent_id, room_id, revoked_at, blocks_reissue)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(token_hash) DO UPDATE SET
             agent_id = excluded.agent_id,
             room_id = excluded.room_id,
             revoked_at = excluded.revoked_at,
             blocks_reissue = 1`,
        )
        .run(tokenHash, agentId, roomId, now);
      const cleared = deps.db
        .prepare("UPDATE agents SET token_hash = NULL WHERE id = ? AND token_hash = ?")
        .run(agentId, tokenHash);
      if (cleared.changes !== 1) throw RoomHttpError.notFound();
    }
    deps.db
      .prepare("UPDATE agent_key_revocations SET blocks_reissue = 1 WHERE agent_id = ? AND room_id = ?")
      .run(agentId, roomId);
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

