import { createHash } from "node:crypto";
import { isIsoTimestamp } from "./clock.js";
import { ContractError } from "./errors.js";
import { isAgentId, isId, isOwnerActorId, isRoomRef } from "./ids.js";
import type { BlockCategory, BlockLocation } from "./guard.js";
import type { ItemKind, SharingLevel } from "./sharing.js";

export const AuditAction = {
  Post: "post",
  Upload: "upload",
  Read: "read",
  Join: "join",
  JoinRefused: "join_refused",
  Wake: "wake",
  WakeRetry: "wake_retry",
  WakeFallbackEmail: "wake_fallback_email",
  WakeFailed: "wake_failed",
  Block: "block",
  SettingChange: "setting_change",
  SettingChangeRefused: "setting_change_refused",
  /** Reserved. No M1 route writes this action. */
  Approval: "approval",
  LoopStop: "loop_stop",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ACTIONS = [
  AuditAction.Post,
  AuditAction.Upload,
  AuditAction.Read,
  AuditAction.Join,
  AuditAction.JoinRefused,
  AuditAction.Wake,
  AuditAction.WakeRetry,
  AuditAction.WakeFallbackEmail,
  AuditAction.WakeFailed,
  AuditAction.Block,
  AuditAction.SettingChange,
  AuditAction.SettingChangeRefused,
  AuditAction.Approval,
  AuditAction.LoopStop,
] as const;

export const AuditResult = {
  Ok: "ok",
  Refused: "refused",
  Blocked: "blocked",
  Retried: "retried",
  FellBack: "fell_back",
  Failed: "failed",
} as const;

export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

export const AUDIT_RESULTS = [
  AuditResult.Ok,
  AuditResult.Refused,
  AuditResult.Blocked,
  AuditResult.Retried,
  AuditResult.FellBack,
  AuditResult.Failed,
] as const;

export const ReasonCode = {
  NotMember: "not_member",
  NotOwner: "not_owner",
  AgentCannotChangeSharing: "agent_cannot_change_sharing",
  SharingNarrow: "sharing_narrow",
  LogOwnerMismatch: "log_owner_mismatch",
  Name: "name",
  HealthNumber: "health_number",
  Dob: "dob",
  WebhookTimeout: "webhook_timeout",
  WebhookHttp: "webhook_http",
  WebhookNetwork: "webhook_network",
  EmailFailed: "email_failed",
  LoopCap: "loop_cap",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export const REASON_CODES = [
  ReasonCode.NotMember,
  ReasonCode.NotOwner,
  ReasonCode.AgentCannotChangeSharing,
  ReasonCode.SharingNarrow,
  ReasonCode.LogOwnerMismatch,
  ReasonCode.Name,
  ReasonCode.HealthNumber,
  ReasonCode.Dob,
  ReasonCode.WebhookTimeout,
  ReasonCode.WebhookHttp,
  ReasonCode.WebhookNetwork,
  ReasonCode.EmailFailed,
  ReasonCode.LoopCap,
] as const;

/**
 * Structured context for a log row.
 * Closed on purpose: unknown keys are rejected so blocked text cannot be stored here.
 */
export interface AuditDetail {
  reasonCode?: ReasonCode;
  category?: BlockCategory;
  location?: BlockLocation;
  level?: SharingLevel;
  fromOwnerId?: string;
  toOwnerId?: string;
  targetOwnerId?: string;
  itemKind?: ItemKind;
  itemId?: string;
  wakeId?: string;
  /** 1-based webhook attempt. Attempt 1 is the first POST. */
  attempt?: number;
  round?: number;
  httpStatus?: number;
  /** Set on wake rows. The row's own agentId is the recipient. */
  authorAgentId?: string;
  authorOwnerId?: string;
}

export interface AuditAppendInput {
  ts: string;
  /** Room id, or `"*"` when the action is not room-scoped. */
  room: string;
  agentId: string;
  ownerId: string;
  action: AuditAction;
  result: AuditResult;
  detail?: AuditDetail;
}

export interface AuditRecord {
  id: string;
  /** 1-based position in the single global chain. */
  seq: number;
  ts: string;
  room: string;
  agentId: string;
  ownerId: string;
  action: AuditAction;
  result: AuditResult;
  detail: AuditDetail;
  prevHash: string;
  hash: string;
}

export const GENESIS_PREV_HASH = "0".repeat(64);

const DETAIL_KEYS = [
  "reasonCode",
  "category",
  "location",
  "level",
  "fromOwnerId",
  "toOwnerId",
  "targetOwnerId",
  "itemKind",
  "itemId",
  "wakeId",
  "attempt",
  "round",
  "httpStatus",
  "authorAgentId",
  "authorOwnerId",
] as const;

type DetailKey = (typeof DETAIL_KEYS)[number];

export type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

export function canonicalJson(value: Canonical): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new ContractError("canonical JSON rejects non-finite numbers");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as { readonly [key: string]: Canonical };
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as Canonical)}`).join(",")}}`;
    }
    default:
      throw new ContractError("canonical JSON rejects this value");
  }
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function assertIdField(value: string, label: string): void {
  if (!isId(value)) throw new ContractError(`audit detail ${label} has an invalid shape`);
}

export function assertDetail(detail: AuditDetail): void {
  const record = detail as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(DETAIL_KEYS as readonly string[]).includes(key)) {
      throw new ContractError(`audit detail key is not allowed: ${key}`);
    }
    if (record[key] === undefined) {
      throw new ContractError(`audit detail ${key} must be omitted, not undefined`);
    }
  }
  const d = detail;
  if (d.reasonCode !== undefined && !includes(REASON_CODES, d.reasonCode)) {
    throw new ContractError("audit detail reasonCode is invalid");
  }
  if (d.category !== undefined && !includes(["name", "health_number", "dob"] as const, d.category)) {
    throw new ContractError("audit detail category is invalid");
  }
  if (
    d.location !== undefined &&
    !includes(["text", "file_body", "file_name", "file_meta"] as const, d.location)
  ) {
    throw new ContractError("audit detail location is invalid");
  }
  if (d.level !== undefined && !includes(["none", "messages", "messages_files"] as const, d.level)) {
    throw new ContractError("audit detail level is invalid");
  }
  if (d.itemKind !== undefined && d.itemKind !== "message" && d.itemKind !== "file") {
    throw new ContractError("audit detail itemKind is invalid");
  }
  for (const key of ["fromOwnerId", "toOwnerId", "targetOwnerId", "authorOwnerId"] as const) {
    if (d[key] !== undefined) assertIdField(d[key], key);
  }
  if (d.authorAgentId !== undefined && !isAgentId(d.authorAgentId)) {
    throw new ContractError("audit detail authorAgentId has an invalid shape");
  }
  if (d.itemId !== undefined && !isId(d.itemId) && !/^[a-z][a-z0-9]*_[0-9a-f-]{36}$/.test(d.itemId)) {
    throw new ContractError("audit detail itemId has an invalid shape");
  }
  if (d.wakeId !== undefined && !/^[a-z][a-z0-9]*_[0-9a-f-]{36}$/.test(d.wakeId) && !isId(d.wakeId)) {
    throw new ContractError("audit detail wakeId has an invalid shape");
  }
  if (d.attempt !== undefined && (!Number.isInteger(d.attempt) || d.attempt < 1 || d.attempt > 4)) {
    throw new ContractError("audit detail attempt must be an integer from 1 to 4");
  }
  if (d.round !== undefined && (!Number.isInteger(d.round) || d.round < 1 || d.round > 100)) {
    throw new ContractError("audit detail round is invalid");
  }
  if (
    d.httpStatus !== undefined &&
    (!Number.isInteger(d.httpStatus) || d.httpStatus < 100 || d.httpStatus > 599)
  ) {
    throw new ContractError("audit detail httpStatus is invalid");
  }
}

export function assertAuditAppend(input: AuditAppendInput): void {
  if (!isIsoTimestamp(input.ts)) throw new ContractError("audit entry missing or invalid time");
  if (!input.room || !isRoomRef(input.room)) throw new ContractError("audit entry missing room");
  if (!input.agentId || (!isAgentId(input.agentId) && !isOwnerActorId(input.agentId))) {
    throw new ContractError("audit entry missing agent");
  }
  if (!input.ownerId || !isId(input.ownerId)) throw new ContractError("audit entry missing owner");
  if (!includes(AUDIT_ACTIONS, input.action)) throw new ContractError("audit entry missing action");
  if (!includes(AUDIT_RESULTS, input.result)) throw new ContractError("audit entry missing result");
  if (isOwnerActorId(input.agentId) && input.agentId !== `owner:${input.ownerId}`) {
    throw new ContractError("owner actor id does not match owner");
  }
  assertDetail(input.detail ?? {});
}

export function detailToCanonical(detail: AuditDetail): Canonical {
  assertDetail(detail);
  const out: Record<string, Canonical> = {};
  const source = detail as Record<DetailKey, Canonical | undefined>;
  for (const key of DETAIL_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface AuditHashCore {
  id: string;
  seq: number;
  ts: string;
  room: string;
  agentId: string;
  ownerId: string;
  action: AuditAction;
  result: AuditResult;
  detail: AuditDetail;
}

/**
 * `sha256(prevHash + "\\n" + canonicalJson(core))` as lowercase hex.
 * `prevHash` is not inside the JSON. Object keys are sorted.
 */
export function computeAuditHash(prevHash: string, core: AuditHashCore): string {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) {
    throw new ContractError("prevHash must be 64 lowercase hex characters");
  }
  if (!Number.isInteger(core.seq) || core.seq < 1) throw new ContractError("audit seq must be a positive integer");
  if (!core.id) throw new ContractError("audit id is missing");
  const payload = canonicalJson({
    action: core.action,
    agentId: core.agentId,
    detail: detailToCanonical(core.detail),
    id: core.id,
    ownerId: core.ownerId,
    result: core.result,
    room: core.room,
    seq: core.seq,
    ts: core.ts,
  });
  return createHash("sha256").update(`${prevHash}\n${payload}`, "utf8").digest("hex");
}

export function sealAuditRecord(prevHash: string, core: AuditHashCore): AuditRecord {
  assertAuditAppend(core);
  const detail = core.detail ?? {};
  const hash = computeAuditHash(prevHash, { ...core, detail });
  return { ...core, detail, prevHash, hash };
}

export type AuditVerifyResult = { ok: true } | { ok: false; brokenIndex: number; seq: number };

/** `records` must already be in ascending `seq` order. Index 0 is seq 1. */
export function verifyAuditChain(records: readonly AuditRecord[]): AuditVerifyResult {
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < records.length; i++) {
    const row = records[i] as AuditRecord;
    const seqOk = row.seq === i + 1;
    const linkOk = row.prevHash === prev;
    let hashOk = false;
    if (seqOk && linkOk) {
      try {
        hashOk = row.hash === computeAuditHash(prev, row);
      } catch {
        hashOk = false;
      }
    }
    if (!seqOk || !linkOk || !hashOk) {
      return { ok: false, brokenIndex: i, seq: row.seq };
    }
    prev = row.hash;
  }
  return { ok: true };
}

export interface AuditLog {
  append(input: AuditAppendInput): AuditRecord;
  verify(): AuditVerifyResult;
  /**
   * Returns rows whose `ownerId` equals `ownerId`, oldest first.
   * The caller must be that owner. A mismatch throws an authorization error
   * after the refusal has been appended.
   */
  listForOwner(requesterOwnerId: string, ownerId: string): AuditRecord[];
}

/**
 * Which actor a row is filed under. Owners only see rows with their ownerId.
 * Wake rows are filed under the recipient so that owner can see them.
 */
export const AUDIT_ACTOR = {
  post: "author",
  upload: "author",
  block: "author",
  read: "caller",
  join: "member",
  join_refused: "caller",
  wake: "recipient",
  wake_retry: "recipient",
  wake_fallback_email: "recipient",
  wake_failed: "recipient",
  setting_change: "caller",
  setting_change_refused: "caller",
  approval: "owner",
  loop_stop: "author",
} as const;
