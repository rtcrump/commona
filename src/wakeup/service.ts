import type BetterSqlite3 from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";
import {
  AuditAction,
  AuditResult,
  ContractError,
  DEFAULT_SHARING_LEVEL,
  NoticeKind,
  ReasonCode,
  WAKE_ATTEMPT_LIMIT,
  WAKE_EVENT_TYPE,
  WAKE_RETRY_DELAYS_MS,
  WAKE_WEBHOOK_TIMEOUT_MS,
  WakeState,
  formatTimestamp,
  isAgentId,
  isId,
  isSharingLevel,
  newId,
  systemClock,
  wakeDisclosure,
  wakeFailedNoticeMessage,
  type AuditDetail,
  type AuditLog,
  type Clock,
  type ItemKind,
  type OwnerNotifier,
  type SharingLevel,
  type WakeAddress,
  type WakeEnqueueInput,
  type WakeEvent,
  type WakeFileContent,
  type WakeMessageContent,
  type WakeQueue,
} from "../../contract/index.js";

type Sqlite = BetterSqlite3.Database;
import { decodeUtf8Text } from "../guard/index.js";
import { buildWakeEmail, wireWakeEvent } from "./event.js";
import { recordersFor } from "./record.js";
import { sendSmtp, type SmtpEndpoint } from "./smtp.js";
import { postWakeWebhook, type WebhookFailure } from "./webhook.js";

export interface WakeServiceOptions {
  db: Sqlite;
  clock?: Clock;
  /** When omitted, wake rows are sealed into `audit_log` with `sealAuditRecord`. */
  audit?: Pick<AuditLog, "append">;
  /** When omitted, a failed delivery inserts an owner notice for the recipient owner. */
  notices?: OwnerNotifier;
  fetchImpl?: typeof fetch;
  /** Defaults to the contract's 5 second webhook timeout. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Required for email to succeed. A missing endpoint fails the email step. */
  smtp?: SmtpEndpoint;
}

export interface WakeDeliveryResult {
  wakeId: string;
  state: WakeState;
  attempts: number;
}

export interface WakeService extends WakeQueue {
  deliver(wakeId: string): Promise<WakeDeliveryResult>;
  /** Delivers every pending wake, older items first and then by recipient agent id. */
  deliverPending(): Promise<WakeDeliveryResult[]>;
}

interface MemberRow {
  agentId: string;
  ownerId: string;
}

interface MessageRow {
  id: string;
  text: string;
  replyToId: string | null;
  round: number;
  held: number;
  authorAgentId: string;
  authorOwnerId: string;
}

interface FileRow {
  id: string;
  name: string;
  mediaType: string;
  content: Buffer;
  metadataJson: string;
  byteLength: number;
  held: number;
  authorAgentId: string;
  authorOwnerId: string;
}

interface WakeRow {
  id: string;
  roomId: string;
  recipientAgentId: string;
  recipientOwnerId: string;
  authorAgentId: string;
  authorOwnerId: string;
  itemKind: ItemKind;
  itemId: string;
  round: number;
  disclosure: WakeEvent["disclosure"];
  payloadJson: string;
  state: WakeState;
  attempts: number;
}

/**
 * T5 wake-up service.
 * T6 owns the round cap: this queue wakes every round it is given, including rounds above 3.
 * Callers that implement the cap should skip enqueue when `wakeSuppressed(round)` is true.
 */
export function createWakeService(options: WakeServiceOptions): WakeService {
  const db = options.db;
  const clock = options.clock ?? systemClock;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WAKE_WEBHOOK_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  const recorders = recordersFor(db, clock, { audit: options.audit, notices: options.notices });
  const inflight = new Map<string, Promise<WakeDeliveryResult>>();

  function now(): string {
    return formatTimestamp(clock.now());
  }

  function enqueue(input: WakeEnqueueInput): WakeEvent[] {
    assertEnqueueInput(input);
    const item = loadItem(db, input);
    if (item.held) return [];
    if (item.authorAgentId !== input.authorAgentId || item.authorOwnerId !== input.authorOwnerId) {
      throw new ContractError("wake author does not match the stored item");
    }
    if (item.kind === "message" && item.round !== input.round) {
      throw new ContractError("wake round does not match the stored message");
    }

    const occurredAt = now();
    const members = db
      .prepare(
        `SELECT agent_id AS agentId, owner_id AS ownerId
         FROM memberships
         WHERE room_id = ? AND agent_id <> ?
         ORDER BY agent_id`,
      )
      .all(input.roomId, input.authorAgentId) as MemberRow[];

    const insert = db.prepare(
      `INSERT INTO wakes (
         id, room_id, recipient_agent_id, recipient_owner_id, author_agent_id, author_owner_id,
         item_kind, item_id, round, disclosure, payload_json, state, attempts, created_at, updated_at
       ) VALUES (
         @id, @roomId, @recipientAgentId, @recipientOwnerId, @authorAgentId, @authorOwnerId,
         @itemKind, @itemId, @round, @disclosure, @payloadJson, @state, 0, @createdAt, @updatedAt
       )`,
    );
    const existing = db.prepare(
      `SELECT id FROM wakes
       WHERE room_id = ? AND item_kind = ? AND item_id = ? AND recipient_agent_id = ?`,
    );

    const write = db.transaction(() => {
      const events: WakeEvent[] = [];
      for (const member of members) {
        if (existing.get(input.roomId, input.itemKind, input.itemId, member.agentId)) continue;
        if (member.ownerId.length === 0 || input.authorOwnerId.length === 0) continue;
        const level = sharingLevel(db, input.roomId, input.authorOwnerId, member.ownerId);
        const disclosure = wakeDisclosure({
          level,
          itemKind: input.itemKind,
          recipientOwnerId: member.ownerId,
          authorOwnerId: input.authorOwnerId,
        });
        const event = buildEvent({
          wakeId: newId("wake"),
          input,
          member,
          occurredAt,
          disclosure,
          item,
        });
        insert.run({
          id: event.wakeId,
          roomId: event.roomId,
          recipientAgentId: event.recipient.agentId,
          recipientOwnerId: event.recipient.ownerId,
          authorAgentId: event.author.agentId,
          authorOwnerId: event.author.ownerId,
          itemKind: input.itemKind,
          itemId: input.itemId,
          round: input.round,
          disclosure: event.disclosure,
          payloadJson: JSON.stringify(event),
          state: WakeState.Pending,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        events.push(event);
      }
      return events;
    });
    return write();
  }

  async function deliver(wakeId: string): Promise<WakeDeliveryResult> {
    const running = inflight.get(wakeId);
    if (running) return running;
    const promise = deliverOne(wakeId).finally(() => {
      inflight.delete(wakeId);
    });
    inflight.set(wakeId, promise);
    return promise;
  }

  async function deliverOne(wakeId: string): Promise<WakeDeliveryResult> {
    const row = loadWake(db, wakeId);
    if (!row) throw new ContractError("wake not found");
    if (row.state !== WakeState.Pending) return snapshot(row);

    const event = wireWakeEvent(parseEvent(row.payloadJson));
    const address = loadAddress(db, row.recipientAgentId);
    let attempts = row.attempts;
    let lastWebhook: WebhookFailure | undefined;

    if (address.webhook) {
      while (attempts < WAKE_ATTEMPT_LIMIT) {
        const attempt = attempts + 1;
        const result = await postWakeWebhook({
          url: address.webhook,
          event,
          timeoutMs,
          fetchImpl,
        });
        attempts = attempt;
        if (result.ok) {
          return commit(row, {
            state: WakeState.WebhookSucceeded,
            attempts,
            action: AuditAction.Wake,
            result: AuditResult.Ok,
            detail: baseDetail(row, { attempt }),
          });
        }
        lastWebhook = result;
        if (attempt < WAKE_ATTEMPT_LIMIT) {
          const delayMs = WAKE_RETRY_DELAYS_MS[attempt - 1];
          if (delayMs === undefined) throw new ContractError("wake retry delay is missing");
          commitAttempt(row, attempts, {
            action: AuditAction.WakeRetry,
            result: AuditResult.Retried,
            detail: baseDetail(row, webhookDetail(result, attempt)),
            ts: now(),
          });
          await sleep(delayMs);
          const fresh = loadWake(db, wakeId);
          if (fresh && fresh.state !== WakeState.Pending) return snapshot(fresh);
        }
      }
    }

    const emailDetail = baseDetail(row, lastWebhook ? webhookDetail(lastWebhook, attempts) : {});
    try {
      if (!options.smtp) throw new Error("smtp is not configured");
      if (!isMailbox(address.email)) throw new Error("recipient email is invalid");
      const email = buildWakeEmail(event, address.email);
      await sendSmtp(options.smtp, email);
      return commit(row, {
        state: WakeState.EmailSent,
        attempts,
        action: AuditAction.WakeFallbackEmail,
        result: AuditResult.FellBack,
        detail: emailDetail,
      });
    } catch {
      return commit(row, {
        state: WakeState.Failed,
        attempts,
        action: AuditAction.WakeFailed,
        result: AuditResult.Failed,
        detail: baseDetail(row, { reasonCode: ReasonCode.EmailFailed }),
        notice: true,
      });
    }
  }

  function commitAttempt(
    row: WakeRow,
    attempts: number,
    audit: { action: AuditAction; result: AuditResult; detail: AuditDetail; ts: string },
  ): void {
    const write = db.transaction(() => {
      db.prepare("UPDATE wakes SET attempts = ?, updated_at = ? WHERE id = ? AND state = ?").run(
        attempts,
        audit.ts,
        row.id,
        WakeState.Pending,
      );
      recorders.audit.append(auditInput(row, audit.action, audit.result, audit.detail, audit.ts));
    });
    write();
  }

  function commit(
    row: WakeRow,
    outcome: {
      state: WakeState;
      attempts: number;
      action: AuditAction;
      result: AuditResult;
      detail: AuditDetail;
      notice?: boolean;
    },
  ): WakeDeliveryResult {
    const stamped = now();
    const write = db.transaction(() => {
      db.prepare("UPDATE wakes SET state = ?, attempts = ?, updated_at = ? WHERE id = ?").run(
        outcome.state,
        outcome.attempts,
        stamped,
        row.id,
      );
      recorders.audit.append(auditInput(row, outcome.action, outcome.result, outcome.detail, stamped));
      if (outcome.notice) {
        recorders.notices.notify({
          ownerId: row.recipientOwnerId,
          roomId: row.roomId,
          kind: NoticeKind.WakeFailed,
          message: wakeFailedNoticeMessage(row.roomId),
          itemId: row.itemId,
        });
      }
    });
    write();
    return { wakeId: row.id, state: outcome.state, attempts: outcome.attempts };
  }

  async function deliverPending(): Promise<WakeDeliveryResult[]> {
    const rows = db
      .prepare(
        `SELECT id FROM wakes
         WHERE state = ?
         ORDER BY created_at, recipient_agent_id, id`,
      )
      .all(WakeState.Pending) as { id: string }[];
    const results: WakeDeliveryResult[] = [];
    for (const row of rows) results.push(await deliver(row.id));
    return results;
  }

  return { enqueue, deliver, deliverPending };
}

function auditInput(
  row: WakeRow,
  action: AuditAction,
  result: AuditResult,
  detail: AuditDetail,
  ts: string,
): Parameters<AuditLog["append"]>[0] {
  return {
    ts,
    room: row.roomId,
    agentId: row.recipientAgentId,
    ownerId: row.recipientOwnerId,
    action,
    result,
    detail,
  };
}

function baseDetail(row: WakeRow, extra: AuditDetail): AuditDetail {
  return omitUndefined({
    wakeId: row.id,
    authorAgentId: row.authorAgentId,
    authorOwnerId: row.authorOwnerId,
    itemKind: row.itemKind,
    itemId: row.itemId,
    round: row.round,
    ...extra,
  });
}

function webhookDetail(failure: WebhookFailure, attempt: number): AuditDetail {
  return omitUndefined({
    attempt,
    reasonCode: failure.reasonCode,
    httpStatus: failure.httpStatus,
  });
}

function omitUndefined(detail: AuditDetail): AuditDetail {
  const out: AuditDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function snapshot(row: WakeRow): WakeDeliveryResult {
  return { wakeId: row.id, state: row.state, attempts: row.attempts };
}

function assertEnqueueInput(input: WakeEnqueueInput): void {
  if (!isId(input.roomId)) throw new ContractError("wake room id has an invalid shape");
  if (!isAgentId(input.authorAgentId)) {
    throw new ContractError("wake author agent id has an invalid shape");
  }
  if (!isId(input.authorOwnerId)) throw new ContractError("wake author owner id has an invalid shape");
  if (input.itemKind !== "message" && input.itemKind !== "file") {
    throw new ContractError("wake itemKind is invalid");
  }
  if (!isId(input.itemId)) throw new ContractError("wake item id has an invalid shape");
  if (!Number.isInteger(input.round) || input.round < 1) {
    throw new ContractError("wake round must be a positive integer");
  }
}

function sharingLevel(db: Sqlite, roomId: string, fromOwnerId: string, toOwnerId: string): SharingLevel {
  if (fromOwnerId.length === 0 || toOwnerId.length === 0) return DEFAULT_SHARING_LEVEL;
  if (fromOwnerId === toOwnerId) return DEFAULT_SHARING_LEVEL;
  const row = db
    .prepare(
      `SELECT level FROM sharing
       WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?`,
    )
    .get(roomId, fromOwnerId, toOwnerId) as { level: string } | undefined;
  if (!row || !isSharingLevel(row.level)) return DEFAULT_SHARING_LEVEL;
  return row.level;
}

type LoadedItem =
  | {
      kind: "message";
      held: boolean;
      authorAgentId: string;
      authorOwnerId: string;
      round: number;
      content: WakeMessageContent;
    }
  | {
      kind: "file";
      held: boolean;
      authorAgentId: string;
      authorOwnerId: string;
      content: WakeFileContent;
    };

function loadItem(db: Sqlite, input: WakeEnqueueInput): LoadedItem {
  if (input.itemKind === "message") {
    const row = db
      .prepare(
        `SELECT id, text, reply_to_id AS replyToId, round, held,
                author_agent_id AS authorAgentId, author_owner_id AS authorOwnerId
         FROM posts WHERE id = ? AND room_id = ?`,
      )
      .get(input.itemId, input.roomId) as MessageRow | undefined;
    if (!row) throw new ContractError("wake item not found");
    return {
      kind: "message",
      held: row.held !== 0,
      authorAgentId: row.authorAgentId,
      authorOwnerId: row.authorOwnerId,
      round: row.round,
      content: {
        kind: "message",
        itemId: row.id,
        text: row.text,
        replyToId: row.replyToId,
        round: row.round,
      },
    };
  }
  const row = db
    .prepare(
      `SELECT id, name, media_type AS mediaType, content, metadata_json AS metadataJson,
              byte_length AS byteLength, held, author_agent_id AS authorAgentId,
              author_owner_id AS authorOwnerId
       FROM files WHERE id = ? AND room_id = ?`,
    )
    .get(input.itemId, input.roomId) as FileRow | undefined;
  if (!row) throw new ContractError("wake item not found");
  const metadata = parseMetadata(row.metadataJson);
  const content: WakeFileContent = {
    kind: "file",
    itemId: row.id,
    name: row.name,
    mediaType: row.mediaType,
    byteLength: row.content.length,
    metadata: metadata ?? {},
  };
  const textBody = decodeUtf8Text(row.content);
  if (textBody !== undefined) content.textBody = textBody;
  return {
    kind: "file",
    held: row.held !== 0 || metadata === null,
    authorAgentId: row.authorAgentId,
    authorOwnerId: row.authorOwnerId,
    content,
  };
}

function buildEvent(args: {
  wakeId: string;
  input: WakeEnqueueInput;
  member: MemberRow;
  occurredAt: string;
  disclosure: WakeEvent["disclosure"];
  item: LoadedItem;
}): WakeEvent {
  const event: WakeEvent = {
    type: WAKE_EVENT_TYPE,
    wakeId: args.wakeId,
    roomId: args.input.roomId,
    occurredAt: args.occurredAt,
    round: args.input.round,
    author: { agentId: args.input.authorAgentId, ownerId: args.input.authorOwnerId },
    recipient: { agentId: args.member.agentId, ownerId: args.member.ownerId },
    disclosure: args.disclosure,
    activity: {},
  };
  if (args.disclosure === "content") {
    event.activity = { itemKind: args.input.itemKind };
    event.content = args.item.content;
  }
  return wireWakeEvent(event);
}

function parseMetadata(json: string): Record<string, string> | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const metadata: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string") return null;
      metadata[key] = item;
    }
    return metadata;
  } catch {
    return null;
  }
}

function loadWake(db: Sqlite, wakeId: string): WakeRow | undefined {
  return db
    .prepare(
      `SELECT id, room_id AS roomId, recipient_agent_id AS recipientAgentId,
              recipient_owner_id AS recipientOwnerId, author_agent_id AS authorAgentId,
              author_owner_id AS authorOwnerId, item_kind AS itemKind, item_id AS itemId,
              round, disclosure, payload_json AS payloadJson, state, attempts
       FROM wakes WHERE id = ?`,
    )
    .get(wakeId) as WakeRow | undefined;
}

function loadAddress(db: Sqlite, agentId: string): WakeAddress {
  // event_target is the M4 seam. Milestone 1 does not deliver it.
  const row = db
    .prepare("SELECT email, webhook_url AS webhook FROM agents WHERE id = ?")
    .get(agentId) as { email: string; webhook: string | null } | undefined;
  if (!row) throw new ContractError("wake recipient is missing");
  const webhook = row.webhook?.trim();
  return {
    email: row.email,
    ...(webhook ? { webhook } : {}),
  };
}

function parseEvent(payloadJson: string): WakeEvent {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new ContractError("wake payload is invalid");
  }
  if (typeof value !== "object" || value === null) throw new ContractError("wake payload is invalid");
  return wireWakeEvent(value as WakeEvent);
}

function isMailbox(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value) && !/[\r\n]/.test(value);
}
