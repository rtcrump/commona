import {
  AuditAction,
  AuditResult,
  isIsoTimestamp,
  ReasonCode,
  type AuthPrincipal,
  type ContentGuard,
} from "../../contract/index.js";
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
  task TEXT,
  end_condition TEXT,
  deadline TEXT,
  post_cap INTEGER
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
  const columns = db.prepare("PRAGMA table_info(room_briefs)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "post_cap")) {
    db.exec("ALTER TABLE room_briefs ADD COLUMN post_cap INTEGER");
  }
  applied.add(db);
}

export function readBrief(deps: RoomDeps, roomId: string): RoomBrief | null {
  ensureBriefSchema(deps.db);
  const row = deps.db
    .prepare("SELECT task, end_condition, deadline FROM room_briefs WHERE room_id = ?")
    .get(roomId) as { task: string | null; end_condition: string | null; deadline: string | null } | undefined;
  // A row may hold only the task cap. That is not a brief, and it is not shown.
  if (!row?.task || !row.end_condition || !row.deadline) return null;
  const brief = { task: row.task, endCondition: row.end_condition, deadline: row.deadline };
  // A blocked name is not shown. The row is not copied into a response or a log.
  if (briefNamesBlocked(deps.guard, brief)) return null;
  return brief;
}

export function saveBrief(deps: RoomDeps, roomId: string, brief: RoomBrief): void {
  assertBriefAllowed(deps.guard, brief);
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
export function optionalBrief(body: unknown, now: Date, guard: ContentGuard): RoomBrief | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!("brief" in body)) return undefined;
  const brief = parseBrief((body as { brief?: unknown }).brief, now);
  assertBriefAllowed(guard, brief);
  return brief;
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
    assertBriefAllowed(deps.guard, brief);
    saveBrief(deps, roomId, brief);
  } catch (error) {
    if (error instanceof BriefInputError) throw RoomHttpError.badRequest();
    throw error;
  }
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

/**
 * The same check an ordinary post uses. A block throws before the text is saved.
 * The error does not include the text.
 */
function assertBriefAllowed(guard: ContentGuard, brief: RoomBrief): void {
  if (briefNamesBlocked(guard, brief)) throw new BriefInputError("Invalid request.");
}

function briefNamesBlocked(guard: ContentGuard, brief: RoomBrief): boolean {
  return (
    guard.check({ kind: "message", text: brief.task }).outcome === "block" ||
    guard.check({ kind: "message", text: brief.endCondition }).outcome === "block"
  );
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
