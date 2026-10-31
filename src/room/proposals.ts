import {
  AuditAction,
  AuditResult,
  HTTP_STATUS,
  isId,
  MAX_MESSAGE_CHARS,
  newId,
  type AuthPrincipal,
  type CreatePostResponse,
  type ProposalWriteResponse,
  type RoomProposal,
  type RoomStatus,
} from "../../contract/index.js";
import { nowStamp, requireMember } from "./access.js";
import { readBrief } from "./brief.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

const LABEL_MAX = 80;
const AGREE_TEXT = "I agree to that time and place.";
const COUNTER_TEXT = "I am not taking that time and place.";

/**
 * Fields that would let one agent speak for someone else.
 * Agreement is always the caller. These keys are rejected.
 */
const ACTOR_KEYS = ["ownerId", "agentId", "forOwnerId", "authorOwnerId", "fromOwnerId", "memberId"] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  author_owner_id TEXT NOT NULL,
  time_label TEXT NOT NULL,
  place TEXT NOT NULL,
  body_text TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_room ON proposals (room_id, created_at, id);

CREATE TABLE IF NOT EXISTS proposal_responses (
  proposal_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agree', 'counter')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, agent_id)
);
`;

/** Thrown when a post arrives after the room is done or stalled. */
export class RoomClosed extends Error {
  readonly status = HTTP_STATUS.conflict;

  constructor(message: string) {
    super(message);
    this.name = "RoomClosed";
  }
}

type PostWriter = (
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  body: unknown,
) => CreatePostResponse;

interface ProposalRow {
  id: string;
  time_label: string;
  place: string;
  body_text: string;
  created_at: string;
}

interface ResponseRow {
  kind: "agree" | "counter";
  agent_id: string;
}

type ParsedProposal =
  | { kind: "propose"; time: string; place: string; text: string }
  | { kind: "agree" | "counter"; proposalId: string };

/** True when the JSON body is a propose, agree, or counter post. */
export function isProposalBody(body: unknown): boolean {
  return isRecord(body) && "kind" in body;
}

export function ensureProposalSchema(db: RoomDeps["db"]): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Done when every current member has agreed to the same proposal.
 * Stalled when the room brief deadline has passed without that.
 * The deadline column is the one the brief stores on room_briefs.
 */
export function roomTalkStatus(deps: RoomDeps, roomId: string): RoomStatus {
  ensureProposalSchema(deps.db);
  const members = memberIds(deps, roomId);
  const proposals = proposalRows(deps, roomId);
  const agreed = agreedAgents(deps, roomId);
  const done = proposals.find((row) => everyoneAgreed(members, agreed.get(row.id)));
  if (done) {
    return {
      status: "done",
      proposalId: done.id,
      time: done.time_label,
      place: done.place,
    };
  }
  const open = proposals.map(toProposal);
  if (deadlinePassed(deps, roomId)) return { status: "stalled", proposals: open };
  return { status: "open", proposals: open };
}

/** Flat fields for a JSON read. `status` is always present. */
export function roomStatusFields(status: RoomStatus): {
  status: RoomStatus["status"];
  proposals?: RoomProposal[];
  proposalId?: string;
  time?: string;
  place?: string;
} {
  if (status.status === "done") {
    return {
      status: "done",
      proposalId: status.proposalId,
      time: status.time,
      place: status.place,
    };
  }
  return { status: status.status, proposals: status.proposals };
}

/**
 * Refuse a post once the room is done or the brief deadline has stalled it.
 * The refusal is audited. The proposal text is not copied into the log.
 */
export function refuseIfRoomClosed(deps: RoomDeps, principal: AuthPrincipal, roomId: string): void {
  const status = roomTalkStatus(deps, roomId);
  if (status.status === "open") return;
  const message = status.status === "done" ? "This room is done." : "This room is stalled.";
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: principal.kind === "agent" ? principal.agentId : principal.ownerId,
    ownerId: principal.ownerId,
    action: AuditAction.Post,
    result: AuditResult.Refused,
    detail: { httpStatus: HTTP_STATUS.conflict, itemKind: "message" },
  });
  throw new RoomClosed(message);
}

/**
 * Propose, agree, or counter.
 * `writePost` is the normal post path, so the guard, cap, and audit stay in one place.
 * Agree always records the caller. A body that names another owner is rejected.
 */
export function submitProposal(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  body: unknown,
  writePost: PostWriter,
): { httpStatus: number; body: ProposalWriteResponse | CreatePostResponse } {
  const parsed = parseProposal(body);
  requireMember(deps, principal, roomId);
  if (principal.kind !== "agent") throw RoomHttpError.forbidden();
  refuseIfRoomClosed(deps, principal, roomId);
  if (parsed.kind === "propose") return writeProposal(deps, principal, roomId, parsed, writePost);
  return writeReply(deps, principal, roomId, parsed, writePost);
}

function writeProposal(
  deps: RoomDeps,
  principal: Extract<AuthPrincipal, { kind: "agent" }>,
  roomId: string,
  parsed: Extract<ParsedProposal, { kind: "propose" }>,
  writePost: PostWriter,
): { httpStatus: number; body: ProposalWriteResponse | CreatePostResponse } {
  const sentence = `Free at ${parsed.time}. Place: ${parsed.place}. ${parsed.text}`;
  if (sentence.length > MAX_MESSAGE_CHARS) throw RoomHttpError.badRequest();
  const posted = writePost(deps, principal, roomId, { text: sentence });
  if (posted.outcome !== "accepted") return { httpStatus: HTTP_STATUS.ok, body: posted };
  ensureProposalSchema(deps.db);
  const proposalId = newId("proposal");
  deps.db
    .prepare(
      `INSERT INTO proposals (
        id, room_id, author_agent_id, author_owner_id, time_label, place, body_text, post_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proposalId,
      roomId,
      principal.agentId,
      principal.ownerId,
      parsed.time,
      parsed.place,
      parsed.text,
      posted.post.id,
      nowStamp(deps),
    );
  return {
    httpStatus: HTTP_STATUS.created,
    body: { outcome: "accepted", proposalId, kind: "propose" },
  };
}

function writeReply(
  deps: RoomDeps,
  principal: Extract<AuthPrincipal, { kind: "agent" }>,
  roomId: string,
  parsed: Extract<ParsedProposal, { kind: "agree" | "counter" }>,
  writePost: PostWriter,
): { httpStatus: number; body: ProposalWriteResponse } {
  ensureProposalSchema(deps.db);
  const proposal = deps.db.prepare("SELECT room_id FROM proposals WHERE id = ?").get(parsed.proposalId) as
    | { room_id: string }
    | undefined;
  if (!proposal || proposal.room_id !== roomId) throw RoomHttpError.badRequest();
  const existing = deps.db
    .prepare("SELECT kind FROM proposal_responses WHERE proposal_id = ? AND agent_id = ?")
    .get(parsed.proposalId, principal.agentId) as { kind: string } | undefined;
  if (existing?.kind === parsed.kind) {
    return {
      httpStatus: HTTP_STATUS.ok,
      body: { outcome: "accepted", proposalId: parsed.proposalId, kind: parsed.kind },
    };
  }
  const sentence = parsed.kind === "agree" ? AGREE_TEXT : COUNTER_TEXT;
  const posted = writePost(deps, principal, roomId, { text: sentence });
  if (posted.outcome !== "accepted") throw RoomHttpError.badRequest();
  deps.db
    .prepare(
      `INSERT INTO proposal_responses (proposal_id, room_id, agent_id, owner_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id, agent_id) DO UPDATE SET
         kind = excluded.kind,
         owner_id = excluded.owner_id,
         room_id = excluded.room_id,
         created_at = excluded.created_at`,
    )
    .run(parsed.proposalId, roomId, principal.agentId, principal.ownerId, parsed.kind, nowStamp(deps));
  return {
    httpStatus: existing ? HTTP_STATUS.ok : HTTP_STATUS.created,
    body: { outcome: "accepted", proposalId: parsed.proposalId, kind: parsed.kind },
  };
}

function parseProposal(body: unknown): ParsedProposal {
  if (!isRecord(body)) throw RoomHttpError.badRequest();
  for (const key of ACTOR_KEYS) {
    if (key in body) throw RoomHttpError.badRequest();
  }
  if (body.kind === "propose") {
    return { kind: "propose", time: requireLabel(body.time), place: requireLabel(body.place), text: requireText(body.text) };
  }
  if (body.kind === "agree" || body.kind === "counter") {
    if (typeof body.proposalId !== "string" || !isId(body.proposalId)) throw RoomHttpError.badRequest();
    return { kind: body.kind, proposalId: body.proposalId };
  }
  throw RoomHttpError.badRequest();
}

function requireLabel(value: unknown): string {
  if (typeof value !== "string") throw RoomHttpError.badRequest();
  const label = value.trim();
  if (label.length === 0 || label.length > LABEL_MAX || /[\r\n]/.test(label)) throw RoomHttpError.badRequest();
  return label;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw RoomHttpError.badRequest();
  if (value.length === 0 || value.length > MAX_MESSAGE_CHARS) throw RoomHttpError.badRequest();
  return value;
}

function memberIds(deps: RoomDeps, roomId: string): string[] {
  const rows = deps.db.prepare("SELECT agent_id FROM memberships WHERE room_id = ?").all(roomId) as {
    agent_id: string;
  }[];
  return rows.map((row) => row.agent_id);
}

function proposalRows(deps: RoomDeps, roomId: string): ProposalRow[] {
  return deps.db
    .prepare(
      "SELECT id, time_label, place, body_text, created_at FROM proposals WHERE room_id = ? ORDER BY created_at, id",
    )
    .all(roomId) as ProposalRow[];
}

function agreedAgents(deps: RoomDeps, roomId: string): Map<string, Set<string>> {
  const rows = deps.db
    .prepare("SELECT proposal_id, agent_id, kind FROM proposal_responses WHERE room_id = ? AND kind = 'agree'")
    .all(roomId) as { proposal_id: string; agent_id: string; kind: ResponseRow["kind"] }[];
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const current = out.get(row.proposal_id) ?? new Set<string>();
    current.add(row.agent_id);
    out.set(row.proposal_id, current);
  }
  return out;
}

function everyoneAgreed(members: readonly string[], agreed: Set<string> | undefined): boolean {
  if (members.length === 0 || !agreed) return false;
  return members.every((agentId) => agreed.has(agentId));
}

function toProposal(row: ProposalRow): RoomProposal {
  return { proposalId: row.id, time: row.time_label, place: row.place, text: row.body_text };
}

/**
 * Stalled uses the room brief deadline from the brief module.
 * No brief means the room cannot stall.
 */
function deadlinePassed(deps: RoomDeps, roomId: string): boolean {
  const brief = readBrief(deps, roomId);
  if (!brief) return false;
  const at = Date.parse(brief.deadline);
  if (Number.isNaN(at)) return false;
  return deps.clock.now().getTime() >= at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
