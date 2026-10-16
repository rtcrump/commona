import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  hashToken,
  isId,
  newId,
  ownerActorId,
  ReasonCode,
  UNSCOPED_ROOM,
  type AuditDetail,
  type AuthPrincipal,
} from "../../contract/index.js";
import { NEW_AGENT_NAME, NEW_OWNER_NAME, openAccount, newSecret } from "../onboarding/account.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { inviteLog } from "./log.js";
import { dropInviteSecret, holdInviteSecret, takeInviteSecret } from "./pending.js";
import { ensureInviteSchema } from "./schema.js";

export const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
export const MAX_INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Anonymous audit actor for a redeem that has no account yet. */
const INVITE_GATE = "invite";

const INVITE_ID_RE = /^inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isInviteId(value: string): boolean {
  return INVITE_ID_RE.test(value);
}

interface InviteRow {
  id: string;
  room_id: string;
  secret_hash: string;
  created_by_owner_id: string;
  created_by_agent_id: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedInvite {
  id: string;
  expiresAt: string;
}

export interface RedeemedInvite {
  owner: { id: string; displayName: string };
  agent: { id: string; displayName: string };
  member: { roomId: string; agentId: string; ownerId: string; createdAt: string };
  sharing: "none";
  sessionToken: string;
}

function actorOf(principal: AuthPrincipal): { agentId: string; ownerId: string } {
  if (principal.kind === "agent") return { agentId: principal.agentId, ownerId: principal.ownerId };
  return { agentId: ownerActorId(principal.ownerId), ownerId: principal.ownerId };
}

function isMember(deps: RoomDeps, principal: AuthPrincipal, roomId: string): boolean {
  if (principal.kind === "agent") {
    const row = deps.db
      .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND agent_id = ?")
      .get(roomId, principal.agentId) as { ok: number } | undefined;
    return row !== undefined;
  }
  const row = deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND owner_id = ?")
    .get(roomId, principal.ownerId) as { ok: number } | undefined;
  return row !== undefined;
}

function loadInvite(deps: RoomDeps, id: string): InviteRow | undefined {
  return deps.db
    .prepare(
      `SELECT id, room_id, secret_hash, created_by_owner_id, created_by_agent_id,
              expires_at, used_at, revoked_at, created_at
       FROM invites WHERE id = ?`,
    )
    .get(id) as InviteRow | undefined;
}

function refuse(
  deps: RoomDeps,
  input: { room: string; agentId: string; ownerId: string; itemId?: string; reasonCode?: ReasonCode },
): never {
  const detail: AuditDetail = {};
  if (input.itemId !== undefined) detail.itemId = input.itemId;
  if (input.reasonCode !== undefined) detail.reasonCode = input.reasonCode;
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: input.room,
    agentId: input.agentId,
    ownerId: input.ownerId,
    action: AuditAction.JoinRefused,
    result: AuditResult.Refused,
    detail,
  });
  inviteLog(`invite refuse id=${input.itemId ?? "-"}`);
  throw RoomHttpError.forbidden();
}

function gateActor(): { agentId: string; ownerId: string } {
  return { agentId: ownerActorId(INVITE_GATE), ownerId: INVITE_GATE };
}

function readExpires(body: unknown): number {
  if (body === undefined || body === null) return DEFAULT_INVITE_TTL_SECONDS;
  if (typeof body !== "object" || Array.isArray(body)) throw RoomHttpError.badRequest();
  const raw = (body as { expiresInSeconds?: unknown }).expiresInSeconds;
  if (raw === undefined) return DEFAULT_INVITE_TTL_SECONDS;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_INVITE_TTL_SECONDS
  ) {
    throw RoomHttpError.badRequest();
  }
  return raw;
}

export function createInvite(deps: RoomDeps, principal: AuthPrincipal, roomId: string, body: unknown): CreatedInvite {
  ensureInviteSchema(deps.db);
  const actor = actorOf(principal);
  const roomOk = isId(roomId);
  if (!roomOk || !isMember(deps, principal, roomId)) {
    refuse(deps, {
      room: roomOk ? roomId : UNSCOPED_ROOM,
      ...actor,
      reasonCode: ReasonCode.NotMember,
    });
  }
  const expiresInSeconds = readExpires(body);
  const nowDate = deps.clock.now();
  const now = formatTimestamp(nowDate);
  const expiresAt = formatTimestamp(new Date(nowDate.getTime() + expiresInSeconds * 1000));
  const id = newId("inv");
  const secret = newSecret();
  deps.db
    .prepare(
      `INSERT INTO invites (
         id, room_id, secret_hash, created_by_owner_id, created_by_agent_id, expires_at, used_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      id,
      roomId,
      hashToken(secret),
      actor.ownerId,
      principal.kind === "agent" ? principal.agentId : null,
      expiresAt,
      now,
    );
  holdInviteSecret(id, secret);
  deps.audit.append({
    ts: now,
    room: roomId,
    agentId: actor.agentId,
    ownerId: actor.ownerId,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: { itemId: id },
  });
  inviteLog(`invite create id=${id} room=${roomId}`);
  return { id, expiresAt };
}

export function revokeInvite(deps: RoomDeps, principal: AuthPrincipal, roomId: string, inviteId: string): void {
  ensureInviteSchema(deps.db);
  const actor = actorOf(principal);
  if (!isInviteId(inviteId)) {
    refuse(deps, { room: UNSCOPED_ROOM, ...gateActor() });
  }
  const row = loadInvite(deps, inviteId);
  const room = deps.db.prepare("SELECT created_by_owner_id FROM rooms WHERE id = ?").get(roomId) as
    | { created_by_owner_id: string }
    | undefined;
  const creatingAgent = principal.kind === "agent" && row?.created_by_agent_id === principal.agentId;
  const roomCreatorAgent =
    principal.kind === "agent" && room !== undefined && principal.ownerId === room.created_by_owner_id;
  const allowed =
    row !== undefined &&
    row.room_id === roomId &&
    room !== undefined &&
    isMember(deps, principal, roomId) &&
    (creatingAgent || roomCreatorAgent);
  if (!row || !allowed || row.used_at !== null || row.revoked_at !== null) {
    refuse(deps, { room: UNSCOPED_ROOM, ...actor, itemId: isInviteId(inviteId) ? inviteId : undefined });
  }
  const now = formatTimestamp(deps.clock.now());
  const updated = deps.db
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .run(now, inviteId);
  if (updated.changes !== 1) {
    refuse(deps, { room: UNSCOPED_ROOM, ...actor, itemId: inviteId });
  }
  dropInviteSecret(inviteId);
  deps.audit.append({
    ts: now,
    room: roomId,
    agentId: actor.agentId,
    ownerId: actor.ownerId,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: { itemId: inviteId },
  });
  inviteLog(`invite revoke id=${inviteId}`);
}

/**
 * First GET of a still-open invite. Returns the secret once so the route can
 * set the cookie. Every other GET returns null and the same public page.
 */
export function secretForCookie(deps: RoomDeps, inviteId: string): string | null {
  ensureInviteSchema(deps.db);
  if (!isInviteId(inviteId)) return null;
  const row = loadInvite(deps, inviteId);
  const now = formatTimestamp(deps.clock.now());
  if (!row || row.used_at !== null || row.revoked_at !== null || row.expires_at <= now) {
    dropInviteSecret(inviteId);
    return null;
  }
  return takeInviteSecret(inviteId);
}

export function redeemInvite(deps: RoomDeps, inviteId: string, secret: string | null, roomHint?: string): RedeemedInvite {
  ensureInviteSchema(deps.db);
  const gate = gateActor();
  if (!isInviteId(inviteId) || !secret) {
    refuse(deps, { room: UNSCOPED_ROOM, ...gate, itemId: isInviteId(inviteId) ? inviteId : undefined });
  }
  const nowDate = deps.clock.now();
  const now = formatTimestamp(nowDate);
  const secretHash = hashToken(secret);
  let redeemed: RedeemedInvite | undefined;
  const write = deps.db.transaction(() => {
    const row = loadInvite(deps, inviteId);
    if (!row || row.secret_hash !== secretHash) return "refuse" as const;
    if (roomHint !== undefined && roomHint !== row.room_id) return "refuse" as const;
    if (row.used_at !== null || row.revoked_at !== null || row.expires_at <= now) return "refuse" as const;
    const marked = deps.db
      .prepare(
        `UPDATE invites SET used_at = ?
         WHERE id = ? AND secret_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(now, inviteId, secretHash, now);
    if (marked.changes !== 1) return "refuse" as const;
    const account = openAccount(deps.db, deps.tokens);
    deps.db
      .prepare("INSERT INTO memberships (room_id, agent_id, owner_id, created_at) VALUES (?, ?, ?, ?)")
      .run(row.room_id, account.agentId, account.ownerId, now);
    const others = deps.db
      .prepare("SELECT DISTINCT owner_id FROM memberships WHERE room_id = ? AND owner_id <> ?")
      .all(row.room_id, account.ownerId) as { owner_id: string }[];
    for (const other of others) {
      deps.sharing.ensurePair(row.room_id, account.ownerId, other.owner_id);
    }
    deps.audit.append({
      ts: now,
      room: row.room_id,
      agentId: account.agentId,
      ownerId: account.ownerId,
      action: AuditAction.Join,
      result: AuditResult.Ok,
      detail: { itemId: inviteId },
    });
    redeemed = {
      owner: { id: account.ownerId, displayName: NEW_OWNER_NAME },
      agent: { id: account.agentId, displayName: NEW_AGENT_NAME },
      member: { roomId: row.room_id, agentId: account.agentId, ownerId: account.ownerId, createdAt: now },
      sharing: "none",
      sessionToken: account.sessionToken,
    };
    return "ok" as const;
  });
  const outcome = write.immediate();
  if (outcome !== "ok" || !redeemed) {
    refuse(deps, { room: UNSCOPED_ROOM, ...gate, itemId: inviteId });
  }
  dropInviteSecret(inviteId);
  inviteLog(`invite redeem id=${inviteId} owner=${redeemed.owner.id} agent=${redeemed.agent.id}`);
  return redeemed;
}
