import { formatTimestamp } from "../../contract/index.js";
import { isInviteId } from "../join/service.js";
import type { RoomDeps } from "../room/deps.js";

export const SHARED_ROOM_LABEL = "the shared room";
const FALLBACK_INVITER = "the person who invited you";
const TITLE_MAX = 80;

export type InviteStatus = "open" | "expired" | "used" | "revoked" | "unknown";

export interface InviteView {
  status: InviteStatus;
  inviter: string;
  roomTitle: string;
}

interface InviteRow {
  room_id: string;
  created_by_owner_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

function plainLabel(value: string | undefined, fallback: string): string {
  const name = value?.trim() ?? "";
  if (!name || name.length > TITLE_MAX || /[\r\n<>]/.test(name)) return fallback;
  return name;
}

/**
 * What the join page may say about an invite.
 * The room id, member ids, and any post or file text stay out of this object.
 */
export function describeInvite(deps: RoomDeps, inviteId: string): InviteView {
  if (!isInviteId(inviteId)) {
    return { status: "unknown", inviter: FALLBACK_INVITER, roomTitle: SHARED_ROOM_LABEL };
  }
  const row = deps.db
    .prepare(
      `SELECT room_id, created_by_owner_id, expires_at, used_at, revoked_at
       FROM invites WHERE id = ?`,
    )
    .get(inviteId) as InviteRow | undefined;
  if (!row) return { status: "unknown", inviter: FALLBACK_INVITER, roomTitle: SHARED_ROOM_LABEL };
  const owner = deps.db.prepare("SELECT display_name FROM owners WHERE id = ?").get(row.created_by_owner_id) as
    | { display_name: string }
    | undefined;
  const title = deps.db.prepare("SELECT title FROM room_titles WHERE room_id = ?").get(row.room_id) as
    | { title: string }
    | undefined;
  const now = formatTimestamp(deps.clock.now());
  let status: InviteStatus = "open";
  if (row.used_at !== null) status = "used";
  else if (row.revoked_at !== null) status = "revoked";
  else if (row.expires_at <= now) status = "expired";
  return {
    status,
    inviter: plainLabel(owner?.display_name, FALLBACK_INVITER),
    roomTitle: plainLabel(title?.title, SHARED_ROOM_LABEL),
  };
}

export function errorSentence(view: InviteView): string {
  if (view.status === "expired") return `This link has expired, so ask ${view.inviter} for a new link.`;
  if (view.status === "used") return `This link has already been used, so ask ${view.inviter} for a new link.`;
  if (view.status === "revoked") return `This link was cancelled, so ask ${view.inviter} for a new link.`;
  return "This link can't be used, so ask the person who sent it for a new link.";
}
