import { createHmac, timingSafeEqual } from "node:crypto";
import { ContractError } from "./errors.js";
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
/** Unix seconds. The signed string is this value, a dot, then the raw body. */
export const WAKE_HEADER_TIMESTAMP = "X-Commona-Timestamp";
/** `v1=` plus the hex HMAC-SHA256. */
export const WAKE_HEADER_SIGNATURE = "X-Commona-Signature";
export const WAKE_SIGNATURE_VERSION = "v1";
/** Reject a timestamp more than five minutes off the receiver's clock. */
export const WAKE_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Off unless set to `1`.
 * When it is on, http is allowed only for hostname `localhost` or `127.0.0.1`.
 * Every other host still needs https. The harness sets this because the fixtures use loopback http.
 */
export const WAKE_INSECURE_WEBHOOK_ENV = "COMMONA_ALLOW_INSECURE_WEBHOOKS";

export const WAKE_WEBHOOK_URL_ERROR =
  "wake webhook URL must use https. http is allowed only for localhost or 127.0.0.1 when the dev flag is set";

export interface WakeWebhookUrlOptions {
  /** Off unless the caller passes true. Does not read the environment by itself. */
  allowInsecureLocalhost?: boolean;
}

export class WakeWebhookUrlError extends ContractError {
  constructor() {
    super(WAKE_WEBHOOK_URL_ERROR);
    this.name = "WakeWebhookUrlError";
  }
}

/** True only when the variable is exactly `1`. */
export function allowInsecureLocalWebhook(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WAKE_INSECURE_WEBHOOK_ENV]?.trim() === "1";
}

/**
 * Registration and send both call this.
 * https is accepted for any host. http is accepted only for localhost or 127.0.0.1,
 * and only when `allowInsecureLocalhost` is true.
 */
export function assertWakeWebhookUrl(url: string, options?: WakeWebhookUrlOptions): void {
  const trimmed = url.trim();
  let target: URL;
  try {
    target = new URL(trimmed);
  } catch {
    throw new WakeWebhookUrlError();
  }
  if (target.protocol === "https:") return;
  const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (target.protocol === "http:" && loopback && options?.allowInsecureLocalhost === true) return;
  throw new WakeWebhookUrlError();
}

/** Decimal unix seconds. This is the timestamp half of the signature input. */
export function wakeTimestamp(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new ContractError("wake timestamp is invalid");
  return String(Math.floor(nowMs / 1000));
}

/** `v1=` + hex(HMAC-SHA256(secret, timestamp + '.' + rawBody)). */
export function signWakeBody(secret: string, timestamp: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `${WAKE_SIGNATURE_VERSION}=${hex}`;
}

/**
 * Receiver check. PR #11's listener is not on this branch, so nothing here calls it yet.
 * A caller passes the raw body bytes, not a re-serialized object.
 * The MAC is compared in constant time. A timestamp more than five minutes away is rejected,
 * including one that is in the future.
 */
export function verifyWakeSignature(args: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs: number;
  toleranceMs?: number;
}): boolean {
  const expected = signWakeBody(args.secret, args.timestamp, args.rawBody);
  const matches = constantTimeEqual(expected, args.signature.trim());
  const tolerance = args.toleranceMs ?? WAKE_SIGNATURE_TOLERANCE_MS;
  return matches && timestampFresh(args.timestamp, args.nowMs, tolerance);
}

function timestampFresh(timestamp: string, nowMs: number, toleranceMs: number): boolean {
  if (!/^[0-9]{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  return Math.abs(nowMs - seconds * 1000) <= toleranceMs;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

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

/**
 * Notice body for a content wake. It names the room and the kind, and nothing from the item.
 * Activity-only mail keeps {@link activityOnlyText}.
 */
export function wakeContentNotice(roomId: string, kind: "message" | "file"): string {
  if (kind === "file") return `New file in ${roomId}, open your agent`;
  return `New message in ${roomId}, open your agent`;
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
