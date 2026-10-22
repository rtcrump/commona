import type Database from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  ownerActorId,
  SharingLevel,
} from "../../contract/index.js";
import type { RoomDeps } from "./deps.js";

const HOST_OUTBOUND_SQL = `CREATE TABLE IF NOT EXISTS host_outbound (
  room_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL
)`;

/** Remember that this host shares Messages with each person who later joins. */
export function rememberHostGrant(db: Database.Database, roomId: string, ownerId: string): void {
  db.exec(HOST_OUTBOUND_SQL);
  db.prepare("INSERT INTO host_outbound (room_id, owner_id) VALUES (?, ?)").run(roomId, ownerId);
}

/**
 * When an invitee joins a room:new room, grant the host's outbound Messages.
 * Uses the sharing service. Does nothing for every other room.
 */
export function grantHostMessages(deps: RoomDeps, roomId: string, toOwnerId: string): void {
  const present = deps.db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'host_outbound'")
    .get() as { ok: number } | undefined;
  if (!present) return;
  const row = deps.db.prepare("SELECT owner_id FROM host_outbound WHERE room_id = ?").get(roomId) as
    | { owner_id: string }
    | undefined;
  if (!row || row.owner_id === toOwnerId) return;
  const principal = { kind: "owner" as const, ownerId: row.owner_id };
  const result = deps.sharing.update(principal, roomId, row.owner_id, toOwnerId, SharingLevel.Messages);
  if (!result.allowed) return;
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: roomId,
    agentId: ownerActorId(row.owner_id),
    ownerId: row.owner_id,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: {
      level: result.sharing.level,
      fromOwnerId: result.sharing.fromOwnerId,
      toOwnerId: result.sharing.toOwnerId,
    },
  });
}
