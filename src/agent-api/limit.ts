import { AuditAction, AuditResult, formatTimestamp, type AuthPrincipal } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { ensureAgentApiSchema } from "./schema.js";

/** Posts allowed for one agent in a sliding hour. */
export const POSTS_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;

/** Thrown when this agent has already posted 30 times in the last hour. */
export class AgentPostLimited extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Try again later.");
    this.name = "AgentPostLimited";
    this.retryAfter = retryAfter;
  }
}

/**
 * Count one post for this agent, or refuse it.
 * The rows sit in the room database. On Cloudflare that database is Durable Object SQLite.
 * A refusal is audited and does not consume a slot.
 */
export function reserveAgentPost(deps: RoomDeps, principal: AuthPrincipal, roomId: string): void {
  if (principal.kind !== "agent") return;
  ensureAgentApiSchema(deps.db);
  const agentId = principal.agentId;
  const nowMs = deps.clock.now().getTime();
  const cutoff = nowMs - HOUR_MS;
  const outcome = deps.db.transaction(() => {
    deps.db.prepare("DELETE FROM agent_post_hits WHERE agent_id = ? AND posted_ms <= ?").run(agentId, cutoff);
    const rows = deps.db
      .prepare("SELECT posted_ms FROM agent_post_hits WHERE agent_id = ? ORDER BY posted_ms ASC")
      .all(agentId) as { posted_ms: number }[];
    if (rows.length >= POSTS_PER_HOUR) {
      const oldest = Number(rows[0]?.posted_ms ?? nowMs);
      const retryAfter = Math.max(1, Math.ceil((oldest + HOUR_MS - nowMs) / 1000));
      return { limited: true as const, retryAfter };
    }
    deps.db.prepare("INSERT INTO agent_post_hits (agent_id, posted_ms) VALUES (?, ?)").run(agentId, nowMs);
    return { limited: false as const };
  }).immediate();
  if (!outcome.limited) return;
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    action: AuditAction.Post,
    result: AuditResult.Refused,
    detail: { httpStatus: 429, itemKind: "message" },
  });
  throw new AgentPostLimited(outcome.retryAfter);
}
