import {
  AuditAction,
  AuditResult,
  ReasonCode,
  type AuditRecord,
  type AuthPrincipal,
} from "../../contract/index.js";
import { actorId, nowStamp, refuse } from "./access.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

export interface DeletedRoom {
  deleted: true;
  audit: AuditRecord;
}

/**
 * The room owner deletes one room.
 * Owner auth is the same check as key revoke: the caller’s owner id is the room creator.
 * An agent key of that owner counts. Anyone else is 401 before this runs, or 403 here.
 *
 * The Worker keeps every room in one SQLite Durable Object. `wipeStorage` is
 * `deleteAlarm` plus `deleteAll`. That clears the dry run when this room is the
 * only one. It would also destroy every other room and the audit chain, so it
 * runs only then. Another room stays. This room’s rows are removed, and the
 * audit row stays in the log.
 *
 * There is no second index object. A wipe removes the log, so the sealed record
 * is returned to the caller. A row delete returns that same record and leaves it
 * in the log.
 */
export async function deleteOwnedRoom(deps: RoomDeps, principal: AuthPrincipal, roomId: string): Promise<DeletedRoom> {
  if (!isRoomId(roomId)) throw RoomHttpError.badRequest();
  const room = deps.db.prepare("SELECT created_by_owner_id FROM rooms WHERE id = ?").get(roomId) as
    | { created_by_owner_id: string }
    | undefined;
  if (!room) throw RoomHttpError.notFound();
  if (principal.ownerId !== room.created_by_owner_id) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.SettingChangeRefused,
      reasonCode: ReasonCode.NotOwner,
      detail: { reasonCode: ReasonCode.NotOwner, itemId: roomId },
    });
  }

  const input = {
    ts: nowStamp(deps),
    room: roomId,
    agentId: actorId(principal),
    ownerId: principal.ownerId,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: { itemId: roomId },
  };
  const rooms = deps.db.prepare("SELECT id FROM rooms").all() as { id: string }[];
  if (rooms.length === 1 && rooms[0]?.id === roomId && deps.wipeStorage) {
    const audit = deps.audit.append(input);
    await deps.wipeStorage();
    return { deleted: true, audit };
  }
  const write = deps.db.transaction(() => {
    purgeRoom(deps.db, roomId);
    return deps.audit.append(input);
  });
  return { deleted: true, audit: write() };
}

function isRoomId(value: string): boolean {
  return /^room_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function purgeRoom(db: RoomDeps["db"], roomId: string): void {
  if (tableExists(db, "invites")) {
    if (tableExists(db, "invite_pending_names")) {
      db.prepare(
        "DELETE FROM invite_pending_names WHERE invite_id IN (SELECT id FROM invites WHERE room_id = ?)",
      ).run(roomId);
    }
    if (tableExists(db, "invite_owners")) {
      db.prepare("DELETE FROM invite_owners WHERE room_id = ?").run(roomId);
    }
    if (tableExists(db, "connect_links")) {
      db.prepare("DELETE FROM connect_links WHERE room_id = ?").run(roomId);
    }
    db.prepare("DELETE FROM invites WHERE room_id = ?").run(roomId);
  }
  deleteWhere(db, "connect_presence", "DELETE FROM connect_presence WHERE room_id = ?", roomId);
  deleteWhere(db, "room_form_tokens", "DELETE FROM room_form_tokens WHERE room_id = ?", roomId);
  deleteWhere(db, "room_key_flash", "DELETE FROM room_key_flash WHERE room_id = ?", roomId);
  deleteWhere(db, "agent_key_revocations", "DELETE FROM agent_key_revocations WHERE room_id = ?", roomId);
  deleteWhere(db, "host_outbound", "DELETE FROM host_outbound WHERE room_id = ?", roomId);
  deleteWhere(db, "room_titles", "DELETE FROM room_titles WHERE room_id = ?", roomId);
  deleteWhere(db, "notices", "DELETE FROM notices WHERE room_id = ?", roomId);
  deleteWhere(db, "wakes", "DELETE FROM wakes WHERE room_id = ?", roomId);
  deleteWhere(db, "files", "DELETE FROM files WHERE room_id = ?", roomId);
  if (tableExists(db, "posts")) {
    db.prepare("UPDATE posts SET reply_to_id = NULL WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM posts WHERE room_id = ?").run(roomId);
  }
  deleteWhere(db, "sharing", "DELETE FROM sharing WHERE room_id = ?", roomId);
  deleteWhere(db, "memberships", "DELETE FROM memberships WHERE room_id = ?", roomId);
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
}

function deleteWhere(db: RoomDeps["db"], table: string, sql: string, roomId: string): void {
  if (!tableExists(db, table)) return;
  db.prepare(sql).run(roomId);
}

function tableExists(db: RoomDeps["db"], table: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}
