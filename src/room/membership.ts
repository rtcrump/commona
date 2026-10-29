import {
  AuditAction,
  AuditResult,
  isAgentId,
  isDisplayName,
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
import { displayNameAllowed } from "../join/agent-name.js";
import { nowStamp, refuse, requireMember, requireRoom } from "./access.js";
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

export interface RoomMemberView {
  agentId: string;
  ownerId: string;
  displayName: string;
  createdAt: string;
}

/**
 * Members of a room, with each agent's current display name.
 * The caller is an agent that already belongs to the room.
 */
export function listRoomMembers(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
): { members: RoomMemberView[] } {
  if (!isId(roomId)) throw RoomHttpError.badRequest();
  requireMember(deps, principal, roomId);
  const rows = deps.db
    .prepare(
      `SELECT memberships.agent_id AS agent_id, memberships.owner_id AS owner_id,
              memberships.created_at AS created_at, agents.display_name AS display_name
       FROM memberships
       JOIN agents ON agents.id = memberships.agent_id
       WHERE memberships.room_id = ?
       ORDER BY memberships.created_at, memberships.agent_id`,
    )
    .all(roomId) as { agent_id: string; owner_id: string; created_at: string; display_name: string }[];
  return {
    members: rows.map((row) => ({
      agentId: row.agent_id,
      ownerId: row.owner_id,
      displayName: row.display_name,
      createdAt: row.created_at,
    })),
  };
}

/**
 * The authenticated agent renames itself.
 * A body that names a different agent is refused and does not change either name.
 */
export function renameJoinedAgent(
  deps: RoomDeps,
  principal: Extract<AuthPrincipal, { kind: "agent" }>,
  roomId: string,
  body: unknown,
): { displayName: string } {
  if (!isId(roomId)) throw RoomHttpError.badRequest();
  requireMember(deps, principal, roomId);
  if (!isRecord(body)) throw RoomHttpError.badRequest();
  if (body.agentId !== undefined && body.agentId !== principal.agentId) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.SettingChangeRefused,
      reasonCode: ReasonCode.NotOwner,
      detail: { reasonCode: ReasonCode.NotOwner, itemId: principal.agentId },
    });
  }
  if (typeof body.name !== "string") throw RoomHttpError.badRequest();
  const name = body.name.trim();
  if (!isDisplayName(name) || !displayNameAllowed(deps, name)) throw RoomHttpError.badRequest();
  const ts = nowStamp(deps);
  const write = deps.db.transaction(() => {
    deps.db.prepare("UPDATE agents SET display_name = ? WHERE id = ?").run(name, principal.agentId);
    deps.audit.append({
      ts,
      room: roomId,
      agentId: principal.agentId,
      ownerId: principal.ownerId,
      action: AuditAction.SettingChange,
      result: AuditResult.Ok,
      detail: { itemId: principal.agentId, displayName: name },
    });
  });
  write.immediate();
  return { displayName: name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
