import { AuditAction, AuditResult, isIsoTimestamp, ReasonCode, type AuthPrincipal } from "../../contract/index.js";
import { actorId, nowStamp, refuse } from "./access.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

const applied = new WeakSet<object>();

/** A task or an end condition may be this long, and no longer. */
export const BRIEF_TEXT_MAX = 280;

/** A deadline may be this far ahead, and no further. */
export const BRIEF_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export const BRIEF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_briefs (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  task TEXT NOT NULL,
  end_condition TEXT NOT NULL,
  deadline TEXT NOT NULL
);
`;

export interface RoomBrief {
  task: string;
  endCondition: string;
  deadline: string;
}

export class BriefInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefInputError";
  }
}

export function ensureBriefSchema(db: RoomDeps["db"]): void {
  if (applied.has(db)) return;
  db.exec(BRIEF_SCHEMA_SQL);
  applied.add(db);
}

export function readBrief(deps: RoomDeps, roomId: string): RoomBrief | null {
  ensureBriefSchema(deps.db);
  const row = deps.db
    .prepare("SELECT task, end_condition, deadline FROM room_briefs WHERE room_id = ?")
    .get(roomId) as { task: string; end_condition: string; deadline: string } | undefined;
  if (!row) return null;
  return { task: row.task, endCondition: row.end_condition, deadline: row.deadline };
}

export function saveBrief(deps: RoomDeps, roomId: string, brief: RoomBrief): void {
  ensureBriefSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO room_briefs (room_id, task, end_condition, deadline) VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         task = excluded.task,
         end_condition = excluded.end_condition,
         deadline = excluded.deadline`,
    )
    .run(roomId, brief.task, brief.endCondition, brief.deadline);
}

/**
 * The brief object on a host request. A missing brief is omitted.
 * A present brief that fails the checks throws, and the caller creates no room.
 */
export function optionalBrief(body: unknown, now: Date): RoomBrief | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!("brief" in body)) return undefined;
  return parseBrief((body as { brief?: unknown }).brief, now);
}

export function parseBrief(value: unknown, now: Date): RoomBrief {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BriefInputError("Invalid request.");
  }
  const task = (value as { task?: unknown }).task;
  const endCondition = (value as { endCondition?: unknown }).endCondition;
  const deadline = (value as { deadline?: unknown }).deadline;
  if (typeof task !== "string" || typeof endCondition !== "string" || typeof deadline !== "string") {
    throw new BriefInputError("Invalid request.");
  }
  return {
    task: requireBriefText(task, "brief task must be short text"),
    endCondition: requireBriefText(endCondition, "brief end condition must be short text"),
    deadline: requireDeadline(deadline, now),
  };
}

/**
 * Replace the brief. Only the owner who created the room may do this.
 * An agent key is refused and the refusal is audited.
 */
export function setBrief(deps: RoomDeps, principal: AuthPrincipal, roomId: string, body: unknown): RoomBrief {
  const room = deps.db.prepare("SELECT created_by_owner_id FROM rooms WHERE id = ?").get(roomId) as
    | { created_by_owner_id: string }
    | undefined;
  if (!room) throw RoomHttpError.notFound();
  if (principal.kind !== "owner" || principal.ownerId !== room.created_by_owner_id) {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.SettingChangeRefused,
      reasonCode: ReasonCode.NotOwner,
      detail: { reasonCode: ReasonCode.NotOwner, itemId: roomId },
    });
  }
  let brief: RoomBrief;
  try {
    brief = parseBrief(body, deps.clock.now());
  } catch (error) {
    if (error instanceof BriefInputError) throw RoomHttpError.badRequest();
    throw error;
  }
  saveBrief(deps, roomId, brief);
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: actorId(principal),
    ownerId: principal.ownerId,
    action: AuditAction.SettingChange,
    result: AuditResult.Ok,
    detail: { itemId: roomId },
  });
  return brief;
}

function requireBriefText(raw: string, message: string): string {
  const text = raw.trim();
  if (!text || text.length > BRIEF_TEXT_MAX || /[\r\n]/.test(text)) {
    throw new BriefInputError(message);
  }
  return text;
}

function requireDeadline(raw: string, now: Date): string {
  const at = Date.parse(raw);
  const start = now.getTime();
  if (!isIsoTimestamp(raw) || Number.isNaN(at) || at <= start || at > start + BRIEF_MAX_MS) {
    throw new BriefInputError("brief deadline must be in the future and at most 30 days out");
  }
  return raw;
}
