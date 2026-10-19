import { AuditAction, AuditResult, formatTimestamp, ownerActorId } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { writePolicyMessages } from "./index.js";

/** Audit owner for the room's invite default. Not a person and not a member. */
export const ROOM_DEFAULT_POLICY_OWNER = "policy";

const SCHEMA = `CREATE TABLE IF NOT EXISTS room_default_post_share (
  room_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  invite_id TEXT NOT NULL,
  PRIMARY KEY (room_id, owner_id)
)`;

export function ensureRoomDefaultSchema(db: RoomDeps["db"]): void {
  db.exec(SCHEMA);
}

/** The owner narrowed an outbound edge, so future invite joins do not share their posts. */
export function clearRoomDefaultPostShare(db: RoomDeps["db"], roomId: string, ownerId: string): void {
  ensureRoomDefaultSchema(db);
  db.prepare("DELETE FROM room_default_post_share WHERE room_id = ? AND owner_id = ?").run(roomId, ownerId);
}

/**
 * An agent that joins by invite shares its own posts with the room.
 * People already here share their posts back only when they joined by invite
 * under this default and their owner has not narrowed it.
 * Files are not granted. The audit actor is the room policy, with the joining invite.
 */
export function grantDefaultRoomPosts(deps: RoomDeps, roomId: string, ownerId: string, inviteId: string): void {
  ensureRoomDefaultSchema(deps.db);
  for (const other of otherOwners(deps, roomId, ownerId)) {
    writePolicyMessages(deps.db, roomId, ownerId, other);
    auditPolicy(deps, roomId, inviteId, ownerId, other);
  }
  for (const other of ownersOnRoomDefault(deps, roomId, ownerId)) {
    writePolicyMessages(deps.db, roomId, other, ownerId);
    auditPolicy(deps, roomId, inviteId, other, ownerId);
  }
  deps.db
    .prepare(
      `INSERT INTO room_default_post_share (room_id, owner_id, invite_id) VALUES (?, ?, ?)
       ON CONFLICT (room_id, owner_id) DO UPDATE SET invite_id = excluded.invite_id`,
    )
    .run(roomId, ownerId, inviteId);
}

function otherOwners(deps: RoomDeps, roomId: string, ownerId: string): string[] {
  const rows = deps.db
    .prepare("SELECT DISTINCT owner_id FROM memberships WHERE room_id = ? AND owner_id <> ?")
    .all(roomId, ownerId) as { owner_id: string }[];
  return rows.map((row) => row.owner_id);
}

function ownersOnRoomDefault(deps: RoomDeps, roomId: string, ownerId: string): string[] {
  const rows = deps.db
    .prepare(
      `SELECT DISTINCT d.owner_id AS owner_id
       FROM room_default_post_share d
       JOIN memberships m ON m.room_id = d.room_id AND m.owner_id = d.owner_id
       WHERE d.room_id = ? AND d.owner_id <> ?`,
    )
    .all(roomId, ownerId) as { owner_id: string }[];
  return rows.map((row) => row.owner_id);
}

function auditPolicy(
  deps: RoomDeps,
  roomId: string,
  inviteId: string,
  fromOwnerId: string,
  toOwnerId: string,
): void {
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: roomId,
    agentId: ownerActorId(ROOM_DEFAULT_POLICY_OWNER),
    ownerId: ROOM_DEFAULT_POLICY_OWNER,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: {
      level: "messages",
      fromOwnerId,
      toOwnerId,
      itemId: inviteId,
    },
  });
}
