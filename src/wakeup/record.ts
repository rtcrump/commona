import type BetterSqlite3 from "better-sqlite3";
import {
  GENESIS_PREV_HASH,
  formatTimestamp,
  newId,
  sealAuditRecord,
  type AuditAppendInput,
  type AuditLog,
  type AuditRecord,
  type Clock,
  type OwnerNotice,
  type OwnerNoticeInput,
  type OwnerNotifier,
} from "../../contract/index.js";
import { recordChainTip } from "../audit/log.js";

type Sqlite = BetterSqlite3.Database;

export interface WakeRecorders {
  audit: Pick<AuditLog, "append">;
  notices: OwnerNotifier;
}

export function recordersFor(
  db: Sqlite,
  clock: Clock,
  overrides: { audit?: Pick<AuditLog, "append">; notices?: OwnerNotifier } = {},
): WakeRecorders {
  return {
    audit: overrides.audit ?? sqliteAudit(db),
    notices: overrides.notices ?? sqliteNotices(db, clock),
  };
}

function sqliteAudit(db: Sqlite): Pick<AuditLog, "append"> {
  return {
    append(input: AuditAppendInput): AuditRecord {
      const write = db.transaction(() => {
        const last = db
          .prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
          .get() as { seq: number; hash: string } | undefined;
        const seq = (last?.seq ?? 0) + 1;
        const prevHash = last?.hash ?? GENESIS_PREV_HASH;
        const record = sealAuditRecord(prevHash, {
          id: newId("log"),
          seq,
          ts: input.ts,
          room: input.room,
          agentId: input.agentId,
          ownerId: input.ownerId,
          action: input.action,
          result: input.result,
          detail: input.detail ?? {},
        });
        db.prepare(
          `INSERT INTO audit_log (
             seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash
           ) VALUES (
             @seq, @id, @ts, @room, @agentId, @ownerId, @action, @result, @detail, @prevHash, @hash
           )`,
        ).run({
          seq: record.seq,
          id: record.id,
          ts: record.ts,
          room: record.room,
          agentId: record.agentId,
          ownerId: record.ownerId,
          action: record.action,
          result: record.result,
          detail: JSON.stringify(record.detail),
          prevHash: record.prevHash,
          hash: record.hash,
        });
        recordChainTip(db, record.seq, record.hash);
        return record;
      });
      return write();
    },
  };
}

function sqliteNotices(db: Sqlite, clock: Clock): OwnerNotifier {
  return {
    notify(input: OwnerNoticeInput): OwnerNotice {
      const notice: OwnerNotice = {
        id: newId("notice"),
        createdAt: formatTimestamp(clock.now()),
        ownerId: input.ownerId,
        roomId: input.roomId,
        kind: input.kind,
        message: input.message,
      };
      if (input.category !== undefined) notice.category = input.category;
      if (input.location !== undefined) notice.location = input.location;
      if (input.itemId !== undefined) notice.itemId = input.itemId;
      db.prepare(
        `INSERT INTO notices (
           id, owner_id, room_id, kind, category, location, message, item_id, created_at
         ) VALUES (
           @id, @ownerId, @roomId, @kind, @category, @location, @message, @itemId, @createdAt
         )`,
      ).run({
        id: notice.id,
        ownerId: notice.ownerId,
        roomId: notice.roomId,
        kind: notice.kind,
        category: notice.category ?? null,
        location: notice.location ?? null,
        message: notice.message,
        itemId: notice.itemId ?? null,
        createdAt: notice.createdAt,
      });
      return notice;
    },
  };
}
