import type { ItemKind, SharingLevel } from "./sharing.js";
import { sharingAllows } from "./sharing.js";

export const WAKE_EVENT_TYPE = "commona.wake" as const;

export const WAKE_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Wait before webhook attempts 2, 3, and 4.
 * Attempt 1 is immediate. After attempt 4 fails, send email.
 */
export const WAKE_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;

export const WAKE_ATTEMPT_LIMIT = 1 + WAKE_RETRY_DELAYS_MS.length;

export const WAKE_EMAIL_FROM = "commona@localhost";

export const WAKE_HEADER_EVENT = "X-Commona-Event";
export const WAKE_HEADER_WAKE_ID = "X-Commona-Wake-Id";
export const WAKE_HEADER_ROOM_ID = "X-Commona-Room-Id";

export type WakeDisclosure = "content" | "activity_only";

export interface WakeAddress {
  /** Absent when email is the only channel. M1 then skips the webhook attempts. */
  webhook?: string;
  email: string;
  /**
   * M4 seam. Milestone 1 does not deliver this.
   * Agents that can only be woken by an MCP or vendor event leave the target here.
   */
  event?: {
    kind: "event";
    target: string;
  };
}

export interface WakeMessageContent {
  kind: "message";
  itemId: string;
  text: string;
  replyToId: string | null;
  round: number;
}

export interface WakeFileContent {
  kind: "file";
  itemId: string;
  name: string;
  mediaType: string;
  byteLength: number;
  metadata: Record<string, string>;
  /** Present when the bytes are scanned text and disclosure is `content`. */
  textBody?: string;
}

export interface WakeEvent {
  type: typeof WAKE_EVENT_TYPE;
  wakeId: string;
  roomId: string;
  occurredAt: string;
  round: number;
  author: { agentId: string; ownerId: string };
  recipient: { agentId: string; ownerId: string };
  disclosure: WakeDisclosure;
  /**
   * `itemKind` is omitted when disclosure is `activity_only`, so the recipient
   * cannot tell a message from a file.
   */
  activity: { itemKind?: ItemKind };
  /** Omitted when disclosure is `activity_only`. */
  content?: WakeMessageContent | WakeFileContent;
}

export interface WakeEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: {
    [WAKE_HEADER_EVENT]: typeof WAKE_EVENT_TYPE;
    [WAKE_HEADER_WAKE_ID]: string;
    [WAKE_HEADER_ROOM_ID]: string;
  };
  event: WakeEvent;
}

export function activityOnlyText(roomId: string): string {
  return `New activity in room ${roomId}.`;
}

export function wakeEmailSubject(event: Pick<WakeEvent, "disclosure" | "roomId" | "content">): string {
  if (event.disclosure === "activity_only") return `Commona: new activity in room ${event.roomId}`;
  if (event.content?.kind === "file") return `Commona: new file in room ${event.roomId}`;
  return `Commona: new message in room ${event.roomId}`;
}

export function wakeDisclosure(args: {
  level: SharingLevel;
  itemKind: ItemKind;
  recipientOwnerId: string;
  authorOwnerId: string;
}): WakeDisclosure {
  return sharingAllows(args.level, args.itemKind, args.recipientOwnerId, args.authorOwnerId)
    ? "content"
    : "activity_only";
}

export interface WakeEnqueueInput {
  roomId: string;
  authorAgentId: string;
  authorOwnerId: string;
  itemKind: ItemKind;
  itemId: string;
  round: number;
}

/**
 * Fan-out excludes the author agent.
 * Other agents of the same owner are included.
 * Blocked items are not enqueued.
 * A None-level recipient still gets an activity-only event.
 */
export interface WakeQueue {
  enqueue(input: WakeEnqueueInput): WakeEvent[];
}

export const WakeState = {
  Pending: "pending",
  WebhookSucceeded: "webhook_succeeded",
  EmailSent: "email_sent",
  Failed: "failed",
} as const;

export type WakeState = (typeof WakeState)[keyof typeof WakeState];

export const WAKE_STATES = [
  WakeState.Pending,
  WakeState.WebhookSucceeded,
  WakeState.EmailSent,
  WakeState.Failed,
] as const;
