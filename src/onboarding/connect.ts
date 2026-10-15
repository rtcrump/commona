import { formatTimestamp, hashToken, isId, newId } from "../../contract/index.js";
import { inviteLog } from "../join/log.js";
import { claimAgentHandoff, issueAgentHandoff, type HandoffDeps } from "./handoff.js";

/** How long Check connection waits for the agent to answer. */
export const CHECK_WAIT_MS = 1000;

export class ConnectError extends Error {
  constructor() {
    super("connect unusable");
    this.name = "ConnectError";
  }
}

export type LinkLabel = "Copy my link" | "Get a new link";

interface HandoffLookup {
  id: string;
  owner_id: string;
  agent_id: string;
  expires_at: string;
  used_at: string | null;
}

/**
 * Mint a single-use connect link for the owner's agent in this room.
 * The raw secret is returned to the caller and is not written to the database.
 */
export function issueConnectLink(
  deps: HandoffDeps,
  ownerId: string,
  roomId: string,
  inviteId: string,
): { secret: string; expiresAt: string } {
  const member = deps.db
    .prepare(
      `SELECT 1 AS ok FROM memberships AS membership
       JOIN owner_agents AS owner_agent ON owner_agent.agent_id = membership.agent_id
       WHERE membership.room_id = ? AND owner_agent.owner_id = ?`,
    )
    .get(roomId, ownerId) as { ok: number } | undefined;
  if (!member) throw new ConnectError();
  const handoff = issueAgentHandoff(deps, ownerId);
  const row = deps.db.prepare("SELECT id FROM agent_handoffs WHERE secret_hash = ?").get(hashToken(handoff.secret)) as
    | { id: string }
    | undefined;
  if (!row) throw new ConnectError();
  deps.db
    .prepare(
      `INSERT INTO connect_links (handoff_id, owner_id, room_id, invite_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.id, ownerId, roomId, inviteId, formatTimestamp(deps.clock.now()));
  inviteLog(`connect issue owner=${ownerId}`);
  return { secret: handoff.secret, expiresAt: handoff.expiresAt };
}

export function linkLabel(deps: HandoffDeps, ownerId: string): LinkLabel {
  const row = deps.db
    .prepare(
      `SELECT expires_at, used_at FROM agent_handoffs WHERE owner_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ownerId) as { expires_at: string; used_at: string | null } | undefined;
  if (!row) return "Copy my link";
  const now = formatTimestamp(deps.clock.now());
  if (row.used_at !== null || row.expires_at <= now) return "Get a new link";
  return "Copy my link";
}

export function hasArrived(deps: HandoffDeps, ownerId: string): boolean {
  const row = deps.db.prepare("SELECT 1 AS ok FROM connect_presence WHERE owner_id = ?").get(ownerId) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

/**
 * Swap a handoff for the agent's credential when the room is the one the link was issued for.
 * A wrong room, a wrong owner, a second use, or an expired link fails without revealing which.
 * A room mismatch does not use up the link.
 */
export function claimConnectLink(
  deps: HandoffDeps,
  secret: string,
  roomId: string,
): { agentId: string; ownerId: string; roomId: string; credential: string } {
  if (!isId(secret) || !isId(roomId)) throw new ConnectError();
  const now = formatTimestamp(deps.clock.now());
  const row = deps.db
    .prepare(
      "SELECT id, owner_id, agent_id, expires_at, used_at FROM agent_handoffs WHERE secret_hash = ?",
    )
    .get(hashToken(secret)) as HandoffLookup | undefined;
  if (!row || row.used_at !== null || row.expires_at <= now) throw new ConnectError();
  const link = deps.db.prepare("SELECT room_id FROM connect_links WHERE handoff_id = ?").get(row.id) as
    | { room_id: string }
    | undefined;
  if (!link || link.room_id !== roomId) throw new ConnectError();
  const member = deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND agent_id = ? AND owner_id = ?")
    .get(roomId, row.agent_id, row.owner_id) as { ok: number } | undefined;
  if (!member) throw new ConnectError();
  let claimed: { agentId: string; ownerId: string; credential: string };
  try {
    claimed = claimAgentHandoff(deps, secret);
  } catch {
    throw new ConnectError();
  }
  if (claimed.ownerId !== row.owner_id || claimed.agentId !== row.agent_id) throw new ConnectError();
  inviteLog(`connect claim owner=${claimed.ownerId} agent=${claimed.agentId}`);
  return { agentId: claimed.agentId, ownerId: claimed.ownerId, roomId, credential: claimed.credential };
}

/** The agent reports that it has the credential. This does not write a room post. */
export function noteArrival(deps: HandoffDeps, agentId: string, ownerId: string): void {
  const link = deps.db
    .prepare("SELECT room_id FROM connect_links WHERE owner_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(ownerId) as { room_id: string } | undefined;
  if (!link) throw new ConnectError();
  const member = deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND agent_id = ? AND owner_id = ?")
    .get(link.room_id, agentId, ownerId) as { ok: number } | undefined;
  if (!member) throw new ConnectError();
  const now = formatTimestamp(deps.clock.now());
  deps.db
    .prepare(
      `INSERT INTO connect_presence (owner_id, agent_id, room_id, checked_in_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         room_id = excluded.room_id,
         checked_in_at = excluded.checked_in_at`,
    )
    .run(ownerId, agentId, link.room_id, now);
  inviteLog(`connect arrive owner=${ownerId} agent=${agentId}`);
}

export function requestCheck(deps: HandoffDeps, ownerId: string): string {
  const agent = deps.db.prepare("SELECT agent_id FROM owner_agents WHERE owner_id = ?").get(ownerId) as
    | { agent_id: string }
    | undefined;
  if (!agent) throw new ConnectError();
  const id = newId("ping");
  deps.db
    .prepare("INSERT INTO connect_pings (id, agent_id, requested_at, answered_at) VALUES (?, ?, ?, NULL)")
    .run(id, agent.agent_id, formatTimestamp(deps.clock.now()));
  inviteLog(`connect ask owner=${ownerId} agent=${agent.agent_id}`);
  return id;
}

export function takePendingCheck(deps: HandoffDeps, agentId: string): string | null {
  const row = deps.db
    .prepare(
      `SELECT id FROM connect_pings
       WHERE agent_id = ? AND answered_at IS NULL
       ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
    )
    .get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function answerCheck(deps: HandoffDeps, agentId: string, checkId: string): boolean {
  if (!isId(checkId)) return false;
  const updated = deps.db
    .prepare(
      "UPDATE connect_pings SET answered_at = ? WHERE id = ? AND agent_id = ? AND answered_at IS NULL",
    )
    .run(formatTimestamp(deps.clock.now()), checkId, agentId);
  if (updated.changes !== 1) return false;
  inviteLog(`connect answer agent=${agentId}`);
  return true;
}

export function checkAnswered(deps: HandoffDeps, checkId: string): boolean {
  const row = deps.db.prepare("SELECT answered_at FROM connect_pings WHERE id = ?").get(checkId) as
    | { answered_at: string | null }
    | undefined;
  return row?.answered_at != null;
}

export async function waitForCheck(deps: HandoffDeps, checkId: string, timeoutMs = CHECK_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (checkAnswered(deps, checkId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Build the one link Claude pastes. The secret is added here and nowhere else. */
export function connectorUrl(base: string, secret: string, roomId: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.searchParams.set("handoff", secret);
  url.searchParams.set("room", roomId);
  return url.toString();
}
