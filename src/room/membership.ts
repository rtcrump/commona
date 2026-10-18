import {
  AuditAction,
  AuditResult,
  isAgentId,
  isId,
  newId,
  ReasonCode,
  UNSCOPED_ROOM,
  type AddMemberResponse,
  type AuthPrincipal,
  type Member,
  type Room,
} from "../../contract/index.js";
import { agentKeyReissueBlocked } from "../agent-api/keys.js";
import { nowStamp, refuse, requireRoom } from "./access.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

interface AgentRow {
  id: string;
  owner_id: string;
  token_hash: string | null;
}

interface MemberRow {
  room_id: string;
  agent_id: string;
  owner_id: string;
  created_at: string;
}

export interface AddMemberResult {
  response: AddMemberResponse;
  created: boolean;
}

/** T2. An owner creates an empty room. Agents are added separately. */
export function createRoom(deps: RoomDeps, principal: AuthPrincipal): Room {
  if (principal.kind !== "owner") {
    refuse(deps, {
      room: UNSCOPED_ROOM,
      principal,
      action: AuditAction.JoinRefused,
      reasonCode: ReasonCode.NotOwner,
    });
  }
  const room: Room = {
    id: newId("room"),
    createdAt: nowStamp(deps),
    createdByOwnerId: principal.ownerId,
  };
  deps.db
    .prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, ?)")
    .run(room.id, room.createdAt, room.createdByOwnerId);
  return room;
}

/**
 * T2 critical core. The caller must be the owner of `agentId`.
 * The first membership is 201. A repeat is 200 and does not mint another token.
 * The raw agent token is returned only by the call that creates it.
 * When two owners both have a member, both sharing directions are ensured at None.
 */
export function addMember(deps: RoomDeps, principal: AuthPrincipal, roomId: string, agentId: string): AddMemberResult {
  if (!isId(roomId) || !isAgentId(agentId)) throw RoomHttpError.badRequest();
  requireRoom(deps, roomId);
  const agent = deps.db
    .prepare("SELECT id, owner_id, token_hash FROM agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
  if (!agent) throw RoomHttpError.notFound();
  if (principal.kind !== "owner" || principal.ownerId !== agent.owner_id) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.JoinRefused,
      reasonCode: ReasonCode.NotOwner,
    });
  }
  if (!agent.token_hash && agentKeyReissueBlocked(deps.db, agent.id)) {
    refuse(deps, { room: roomId, principal, action: AuditAction.JoinRefused });
  }

  const existing = deps.db
    .prepare("SELECT room_id, agent_id, owner_id, created_at FROM memberships WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agent.id) as MemberRow | undefined;
  if (existing) {
    return { created: false, response: memberResponse(deps, agent, mapMember(existing)) };
  }

  const createdAt = nowStamp(deps);
  deps.db
    .prepare("INSERT INTO memberships (room_id, agent_id, owner_id, created_at) VALUES (?, ?, ?, ?)")
    .run(roomId, agent.id, agent.owner_id, createdAt);
  ensureSharingPairs(deps, roomId, agent.owner_id);
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: agent.id,
    ownerId: agent.owner_id,
    action: AuditAction.Join,
    result: AuditResult.Ok,
    detail: {},
  });
  return {
    created: true,
    response: memberResponse(deps, agent, {
      roomId,
      agentId: agent.id,
      ownerId: agent.owner_id,
      createdAt,
    }),
  };
}

function memberResponse(deps: RoomDeps, agent: AgentRow, member: Member): AddMemberResponse {
  if (agent.token_hash) return { member };
  return { member, token: deps.tokens.issueAgentToken(agent.id) };
}

/** Contract: pairs appear the first time both owners have a member. Never overwrite. */
function ensureSharingPairs(deps: RoomDeps, roomId: string, ownerId: string): void {
  const others = deps.db
    .prepare("SELECT DISTINCT owner_id FROM memberships WHERE room_id = ? AND owner_id <> ?")
    .all(roomId, ownerId) as { owner_id: string }[];
  for (const other of others) {
    deps.sharing.ensurePair(roomId, ownerId, other.owner_id);
  }
}

function mapMember(row: MemberRow): Member {
  return {
    roomId: row.room_id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}
