import type Database from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  canonicalJson,
  DEFAULT_SHARING_LEVEL,
  detailToCanonical,
  formatTimestamp,
  GENESIS_PREV_HASH,
  isSharingLevel,
  newId,
  ownerActorId,
  ReasonCode,
  sealAuditRecord,
  SharingLevel,
  UNSCOPED_ROOM,
  verifyAuditChain,
  type AuditAppendInput,
  type AuditLog,
  type AuditRecord,
  type AuditVerifyResult,
  type Clock,
  type SharingDirectory,
  type SharingLevel as SharingLevelName,
  type SharingRow,
} from "../../contract/index.js";

type Sqlite = Database.Database;

export interface TestAuditLog extends AuditLog {
  all(): AuditRecord[];
}

export function steppingClock(start = "2026-01-02T03:04:05.000Z"): Clock {
  let ms = Date.parse(start);
  return {
    now() {
      const date = new Date(ms);
      ms += 1;
      return date;
    },
  };
}

/** Contract-shaped log used by room tests. The audit workstream owns the production writer. */
export function createTestAudit(db: Sqlite, clock: Clock): TestAuditLog {
  return {
    append(input: AuditAppendInput): AuditRecord {
      const last = db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string }
        | undefined;
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
        detail: canonicalJson(detailToCanonical(record.detail)),
        prevHash: record.prevHash,
        hash: record.hash,
      });
      return record;
    },
    verify(): AuditVerifyResult {
      return verifyAuditChain(this.all());
    },
    listForOwner(requesterOwnerId: string, ownerId: string): AuditRecord[] {
      if (requesterOwnerId !== ownerId) {
        this.append({
          ts: formatTimestamp(clock.now()),
          room: UNSCOPED_ROOM,
          agentId: ownerActorId(requesterOwnerId),
          ownerId: requesterOwnerId,
          action: AuditAction.Read,
          result: AuditResult.Refused,
          detail: { reasonCode: ReasonCode.LogOwnerMismatch, targetOwnerId: ownerId },
        });
        throw new Error("log owner mismatch");
      }
      return this.all().filter((row) => row.ownerId === ownerId);
    },
    all(): AuditRecord[] {
      const rows = db
        .prepare(
          `SELECT seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash
           FROM audit_log ORDER BY seq`,
        )
        .all() as Array<{
        seq: number;
        id: string;
        ts: string;
        room: string;
        agent_id: string;
        owner_id: string;
        action: AuditRecord["action"];
        result: AuditRecord["result"];
        detail_json: string;
        prev_hash: string;
        hash: string;
      }>;
      return rows.map((row) => ({
        seq: row.seq,
        id: row.id,
        ts: row.ts,
        room: row.room,
        agentId: row.agent_id,
        ownerId: row.owner_id,
        action: row.action,
        result: row.result,
        detail: JSON.parse(row.detail_json) as AuditRecord["detail"],
        prevHash: row.prev_hash,
        hash: row.hash,
      }));
    },
  };
}

/**
 * Stores the sharing rows the room asks for. Level changes are the sharing workstream's route;
 * room tests use `openRoomSharing` so R1 can see both owners' messages and files.
 */
export function createTestSharing(db: Sqlite): SharingDirectory {
  return {
    level(roomId: string, fromOwnerId: string, toOwnerId: string): SharingLevelName {
      const row = db
        .prepare("SELECT level FROM sharing WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?")
        .get(roomId, fromOwnerId, toOwnerId) as { level: string } | undefined;
      if (!row || !isSharingLevel(row.level)) return DEFAULT_SHARING_LEVEL;
      return row.level;
    },
    ensurePair(roomId: string, ownerA: string, ownerB: string): void {
      if (ownerA === ownerB) return;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO sharing (room_id, from_owner_id, to_owner_id, level) VALUES (?, ?, ?, ?)",
      );
      insert.run(roomId, ownerA, ownerB, SharingLevel.None);
      insert.run(roomId, ownerB, ownerA, SharingLevel.None);
    },
    put(roomId: string, fromOwnerId: string, toOwnerId: string, level: SharingLevelName): SharingRow {
      if (!isSharingLevel(level)) throw new Error("invalid sharing level");
      db.prepare(
        `INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level) VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, from_owner_id, to_owner_id) DO UPDATE SET level = excluded.level`,
      ).run(roomId, fromOwnerId, toOwnerId, level);
      return { roomId, fromOwnerId, toOwnerId, level };
    },
  };
}

/** Test-only helper. Opens both directions to Messages + files so R1 can read across owners. */
export function openRoomSharing(sharing: SharingDirectory, roomId: string, ownerA: string, ownerB: string): void {
  sharing.put(roomId, ownerA, ownerB, SharingLevel.MessagesFiles);
  sharing.put(roomId, ownerB, ownerA, SharingLevel.MessagesFiles);
}
