import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  principalActor,
  ReasonCode,
  type AuditAction as AuditActionName,
  type AuditDetail,
  type AuthPrincipal,
  type ReasonCode as ReasonName,
} from "../../contract/index.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

export function nowStamp(deps: RoomDeps): string {
  return formatTimestamp(deps.clock.now());
}

export function actorId(principal: AuthPrincipal): string {
  return principalActor(principal).agentId;
}

export function requireRoom(deps: RoomDeps, roomId: string): void {
  const room = deps.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId) as { id: string } | undefined;
  if (!room) throw RoomHttpError.notFound();
}

export function refuse(
  deps: RoomDeps,
  input: {
    room: string;
    principal: AuthPrincipal;
    action: AuditActionName;
    reasonCode?: ReasonName;
    detail?: AuditDetail;
  },
): never {
  const detail = input.detail ?? (input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {});
  deps.audit.append({
    ts: nowStamp(deps),
    room: input.room,
    agentId: actorId(input.principal),
    ownerId: input.principal.ownerId,
    action: input.action,
    result: AuditResult.Refused,
    detail,
  });
  throw RoomHttpError.forbidden(input.reasonCode);
}

/** Membership gate for agent routes. A known non-member is `join_refused`, not `post` or `read`. */
export function requireMember(deps: RoomDeps, principal: AuthPrincipal, roomId: string): void {
  requireRoom(deps, roomId);
  if (principal.kind !== "agent") {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.JoinRefused,
      reasonCode: ReasonCode.NotOwner,
    });
  }
  const member = deps.db
    .prepare("SELECT agent_id FROM memberships WHERE room_id = ? AND agent_id = ?")
    .get(roomId, principal.agentId) as { agent_id: string } | undefined;
  if (!member) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.JoinRefused,
      reasonCode: ReasonCode.NotMember,
    });
  }
}
