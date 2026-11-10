import {
  AuditAction,
  AuditResult,
  NoticeKind,
  ReasonCode,
  WAKE_EMAIL_FROM,
  blockNoticeMessage,
  formatTimestamp,
  loopStopNoticeMessage,
  type BlockCategory,
  type BlockLocation,
} from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { sendPlainMail } from "../wakeup/smtp.js";

/**
 * Tell the author's owner, and email that owner's address.
 * The message names the category and the location. It does not include the matched text.
 * A mail failure does not change the held item or add an audit row.
 */
export function recordBlock(
  deps: RoomDeps,
  args: {
    roomId: string;
    ownerId: string;
    kind: "message" | "file";
    category: BlockCategory;
    location: BlockLocation;
    itemId: string;
  },
): void {
  const message = blockNoticeMessage({
    roomId: args.roomId,
    kind: args.kind,
    category: args.category,
    location: args.location,
  });
  deps.notices.notify({
    ownerId: args.ownerId,
    roomId: args.roomId,
    kind: NoticeKind.Block,
    category: args.category,
    location: args.location,
    message,
    itemId: args.itemId,
  });
  if (!deps.smtp) return;
  const owner = deps.db.prepare("SELECT email FROM owners WHERE id = ?").get(args.ownerId) as
    | { email: string }
    | undefined;
  if (!owner?.email) return;
  void sendPlainMail(deps.smtp, {
    from: WAKE_EMAIL_FROM,
    to: owner.email,
    subject: `Commona: held ${args.kind} in room ${args.roomId}`,
    text: message,
  }).catch(() => undefined);
}

/**
 * Round above the cap is already stored. This appends `loop_stop` / `ok` for the author
 * and notifies every owner who has a member in the room. It does not send a wake or an email.
 */
export function recordLoopStop(
  deps: RoomDeps,
  args: {
    roomId: string;
    authorAgentId: string;
    authorOwnerId: string;
    itemKind: "message" | "file";
    itemId: string;
    round: number;
  },
): void {
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: args.roomId,
    agentId: args.authorAgentId,
    ownerId: args.authorOwnerId,
    action: AuditAction.LoopStop,
    result: AuditResult.Ok,
    detail: {
      reasonCode: ReasonCode.LoopCap,
      round: args.round,
      itemKind: args.itemKind,
      itemId: args.itemId,
    },
  });
  const message = loopStopNoticeMessage(args.roomId);
  const owners = deps.db
    .prepare("SELECT DISTINCT owner_id AS ownerId FROM memberships WHERE room_id = ? ORDER BY owner_id")
    .all(args.roomId) as { ownerId: string }[];
  for (const owner of owners) {
    deps.notices.notify({
      ownerId: owner.ownerId,
      roomId: args.roomId,
      kind: NoticeKind.LoopStop,
      message,
      itemId: args.itemId,
    });
  }
}
