import {
  AuditAction,
  AuditResult,
  ContractError,
  isId,
  isSharingLevel,
  SharingLevel,
  type AuthPrincipal,
  type PutSharingResponse,
  type SharingLevel as SharingLevelName,
} from "../../contract/index.js";
import { clearRoomDefaultPostShare } from "../onboarding/room-default-share.js";
import { actorId, nowStamp, refuse, requireRoom } from "./access.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

/**
 * The room route for `PUT /rooms/:roomId/sharing`.
 * `SharingDirectory.update` decides whether the caller may write.
 * This route writes the audit row. A `ContractError` is HTTP 400 and is not audited.
 */
export function updateSharing(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  body: unknown,
): PutSharingResponse {
  const request = parseSharing(body);
  if (!isId(roomId)) throw RoomHttpError.badRequest();
  requireRoom(deps, roomId);
  let result;
  try {
    result = deps.sharing.update(principal, roomId, request.fromOwnerId, request.toOwnerId, request.level);
  } catch (error) {
    if (error instanceof ContractError) throw RoomHttpError.badRequest();
    throw error;
  }
  if (!result.allowed) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.SettingChangeRefused,
      reasonCode: result.reasonCode,
      detail: {
        reasonCode: result.reasonCode,
        level: request.level,
        fromOwnerId: request.fromOwnerId,
        toOwnerId: request.toOwnerId,
      },
    });
  }
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: actorId(principal),
    ownerId: principal.ownerId,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: {
      level: result.sharing.level,
      fromOwnerId: result.sharing.fromOwnerId,
      toOwnerId: result.sharing.toOwnerId,
    },
  });
  if (result.sharing.level === SharingLevel.None) {
    clearRoomDefaultPostShare(deps.db, roomId, result.sharing.fromOwnerId);
  }
  return { sharing: result.sharing };
}

function parseSharing(body: unknown): { fromOwnerId: string; toOwnerId: string; level: SharingLevelName } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw RoomHttpError.badRequest();
  const record = body as { fromOwnerId?: unknown; toOwnerId?: unknown; level?: unknown };
  if (typeof record.fromOwnerId !== "string" || !isId(record.fromOwnerId)) throw RoomHttpError.badRequest();
  if (typeof record.toOwnerId !== "string" || !isId(record.toOwnerId)) throw RoomHttpError.badRequest();
  if (!isSharingLevel(record.level)) throw RoomHttpError.badRequest();
  return { fromOwnerId: record.fromOwnerId, toOwnerId: record.toOwnerId, level: record.level };
}
