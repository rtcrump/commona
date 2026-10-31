import { AuditAction, AuditResult, formatTimestamp, type AuthPrincipal } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { ensureAgentApiSchema } from "./schema.js";

/** Posts allowed for one agent in a sliding hour. */
export const POSTS_PER_HOUR = 30;

/**
 * Posts allowed for one agent in one room, for one task.
 * The brief can set another number in room_briefs.post_cap. A missing brief uses this.
 */
export const DEFAULT_TASK_POSTS = 12;

const HOUR_MS = 60 * 60 * 1000;

/** Thrown when this agent has already posted 30 times in the last hour, or has hit the task cap. */
export class AgentPostLimited extends Error {
  /** Seconds until the hourly window moves. Null when the task cap does not reset on a timer. */
  readonly retryAfter: number | null;

  constructor(retryAfter: number | null, message = "Try again later.") {
    super(message);
    this.name = "AgentPostLimited";
    this.retryAfter = retryAfter;
  }
}

/** Plain sentence for a task-cap refusal. The hourly refusal keeps its own sentence. */
export function taskCapMessage(cap: number): string {
  return `This task allows ${cap} posts in this room. That limit has been reached.`;
}

/**
 * Count one post for this agent, or refuse it.
 * The rows sit in the room database. On Cloudflare that database is Durable Object SQLite.
 * A refusal is audited and does not consume a slot.
 */
export function reserveAgentPost(deps: RoomDeps, principal: AuthPrincipal, roomId: string): void {
  if (principal.kind !== "agent") return;
  const room = deps.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId) as { id: string } | undefined;
  if (!room) throw RoomHttpError.notFound();
  ensureAgentApiSchema(deps.db);
  const agentId = principal.agentId;
  const cap = taskPostCap(deps, roomId);
  const posted = deps.db
    .prepare("SELECT COUNT(*) AS n FROM posts WHERE room_id = ? AND author_agent_id = ?")
    .get(roomId, agentId) as { n: number };
  if (Number(posted.n) >= cap) {
    deps.audit.append({
      ts: formatTimestamp(deps.clock.now()),
      room: roomId,
      agentId: principal.agentId,
      ownerId: principal.ownerId,
      action: AuditAction.Post,
      result: AuditResult.Refused,
      detail: { httpStatus: 429, itemKind: "message" },
    });
    throw new AgentPostLimited(null, taskCapMessage(cap));
  }
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

/**
 * The brief's per-task cap for this room, or {@link DEFAULT_TASK_POSTS} when the brief has not set one.
 * Reads room_briefs.post_cap when that table and column exist. Does not create them.
 */
export function taskPostCap(deps: RoomDeps, roomId: string): number {
  const table = deps.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_briefs'")
    .get() as { name: string } | undefined;
  if (!table) return DEFAULT_TASK_POSTS;
  const columns = deps.db.prepare("PRAGMA table_info(room_briefs)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "post_cap")) return DEFAULT_TASK_POSTS;
  const row = deps.db.prepare("SELECT post_cap FROM room_briefs WHERE room_id = ?").get(roomId) as
    | { post_cap: number | null }
    | undefined;
  const cap = Number(row?.post_cap);
  if (!Number.isInteger(cap) || cap < 1) return DEFAULT_TASK_POSTS;
  return cap;
}

/**
 * Store the brief's per-task cap. Tests and the brief writer use this.
 * Creates room_briefs when the brief table is not there yet, and adds post_cap when the table already exists.
 */
export function rememberBriefPostCap(db: RoomDeps["db"], roomId: string, postCap: number): void {
  if (!Number.isInteger(postCap) || postCap < 1) throw new Error("post cap must be a positive integer");
  db.exec("CREATE TABLE IF NOT EXISTS room_briefs (room_id TEXT PRIMARY KEY, post_cap INTEGER NOT NULL)");
  const columns = db.prepare("PRAGMA table_info(room_briefs)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "post_cap")) {
    db.exec("ALTER TABLE room_briefs ADD COLUMN post_cap INTEGER");
  }
  db.prepare(
    `INSERT INTO room_briefs (room_id, post_cap) VALUES (?, ?)
     ON CONFLICT(room_id) DO UPDATE SET post_cap = excluded.post_cap`,
  ).run(roomId, postCap);
}
