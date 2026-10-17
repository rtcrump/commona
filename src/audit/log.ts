import type Database from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  GENESIS_PREV_HASH,
  ReasonCode,
  UNSCOPED_ROOM,
  canonicalJson,
  detailToCanonical,
  formatTimestamp,
  newId,
  ownerActorId,
  sealAuditRecord,
  systemClock,
  verifyAuditChain,
  type AuditAppendInput,
  type AuditDetail,
  type AuditLog,
  type AuditRecord,
  type AuditVerifyResult,
  type Clock,
} from "../../contract/index.js";

/** Refusal reasons this module writes for a log read. */
export type LogReadRefusalReason = typeof ReasonCode.LogOwnerMismatch | typeof ReasonCode.NotOwner;

export class AuditForbiddenError extends Error {
  readonly reasonCode: LogReadRefusalReason;

  constructor(reasonCode: LogReadRefusalReason) {
    super("Not allowed.");
    this.name = "AuditForbiddenError";
    this.reasonCode = reasonCode;
  }
}

interface StoredAuditRow {
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
}

interface ChainTip {
  seq: number;
  hash: string;
}

const SELECT_COLUMNS = `seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash`;

/**
 * Body of a refused log read. Filed under the caller, with room `*`.
 * `targetOwnerId` is the owner named in the request.
 */
export function refusedLogRead(
  clock: Clock,
  caller: { agentId: string; ownerId: string },
  targetOwnerId: string,
  reasonCode: LogReadRefusalReason,
): AuditAppendInput {
  return {
    ts: formatTimestamp(clock.now()),
    room: UNSCOPED_ROOM,
    agentId: caller.agentId,
    ownerId: caller.ownerId,
    action: AuditAction.Read,
    result: AuditResult.Refused,
    detail: { reasonCode, targetOwnerId },
  };
}

function rowToRecord(row: StoredAuditRow): AuditRecord {
  const detail: unknown = JSON.parse(row.detail_json);
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    room: row.room,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    action: row.action,
    result: row.result,
    detail: detail as AuditDetail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function assertAppendOnlyTriggers(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'",
    )
    .all() as { name: string }[];
  const names = new Set(rows.map((row) => row.name));
  if (!names.has("audit_log_no_update") || !names.has("audit_log_no_delete")) {
    throw new Error("audit log is missing append-only triggers");
  }
  const tipRows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_chain_tip'",
    )
    .all() as { name: string }[];
  const tipNames = new Set(tipRows.map((row) => row.name));
  if (!tipNames.has("audit_chain_tip_no_delete") || !tipNames.has("audit_chain_tip_forward_only")) {
    throw new Error("audit log is missing chain tip triggers");
  }
}

/** Stores the latest seq and hash. The first append inserts the row; later appends move it forward by one. */
export function recordChainTip(db: Database.Database, seq: number, hash: string): void {
  const existing = db.prepare("SELECT seq FROM audit_chain_tip WHERE id = 1").get() as { seq: number } | undefined;
  if (!existing) {
    db.prepare("INSERT INTO audit_chain_tip (id, seq, hash) VALUES (1, ?, ?)").run(seq, hash);
    return;
  }
  db.prepare("UPDATE audit_chain_tip SET seq = ?, hash = ? WHERE id = 1").run(seq, hash);
}

/**
 * Append-only log on the schema from `SCHEMA_SQL`.
 * One global chain. The first `prevHash` is 64 zero hex digits.
 * `sealAuditRecord` computes the hash. Triggers reject update and delete.
 */
export function createAuditLog(db: Database.Database, clock: Clock = systemClock): AuditLog {
  assertAppendOnlyTriggers(db);

  const insert = db.prepare(
    `INSERT INTO audit_log (${SELECT_COLUMNS})
     VALUES (@seq, @id, @ts, @room, @agent_id, @owner_id, @action, @result, @detail_json, @prev_hash, @hash)`,
  );
  const latest = db.prepare(
    `SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
  );
  const byOwner = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM audit_log WHERE owner_id = ? ORDER BY seq ASC`,
  );
  const allRows = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM audit_log ORDER BY seq ASC`,
  );
  const tipRow = db.prepare("SELECT seq, hash FROM audit_chain_tip WHERE id = 1");

  const write = db.transaction((input: AuditAppendInput): AuditRecord => {
    const tip = latest.get() as ChainTip | undefined;
    const seq = tip ? tip.seq + 1 : 1;
    const prevHash = tip ? tip.hash : GENESIS_PREV_HASH;
    const detail = input.detail ?? {};
    const record = sealAuditRecord(prevHash, {
      id: newId("log"),
      seq,
      ts: input.ts,
      room: input.room,
      agentId: input.agentId,
      ownerId: input.ownerId,
      action: input.action,
      result: input.result,
      detail,
    });
    insert.run({
      seq: record.seq,
      id: record.id,
      ts: record.ts,
      room: record.room,
      agent_id: record.agentId,
      owner_id: record.ownerId,
      action: record.action,
      result: record.result,
      detail_json: canonicalJson(detailToCanonical(record.detail)),
      prev_hash: record.prevHash,
      hash: record.hash,
    });
    recordChainTip(db, record.seq, record.hash);
    return record;
  });

  function append(input: AuditAppendInput): AuditRecord {
    return write.immediate(input);
  }

  return {
    append,
    verify(): AuditVerifyResult {
      const rows = allRows.all() as StoredAuditRow[];
      const chain = verifyAuditChain(rows.map(rowToRecord));
      if (!chain.ok) return chain;
      const tip = tipRow.get() as ChainTip | undefined;
      if (rows.length === 0) return tip ? { ok: false, brokenIndex: 0, seq: tip.seq } : { ok: true };
      const last = rows[rows.length - 1] as StoredAuditRow;
      if (!tip || tip.seq !== last.seq || tip.hash !== last.hash) {
        return { ok: false, brokenIndex: rows.length, seq: tip?.seq ?? last.seq };
      }
      return { ok: true };
    },
    listForOwner(requesterOwnerId: string, ownerId: string): AuditRecord[] {
      if (requesterOwnerId !== ownerId) {
        append(
          refusedLogRead(
            clock,
            { agentId: ownerActorId(requesterOwnerId), ownerId: requesterOwnerId },
            ownerId,
            ReasonCode.LogOwnerMismatch,
          ),
        );
        throw new AuditForbiddenError(ReasonCode.LogOwnerMismatch);
      }
      const rows = byOwner.all(ownerId) as StoredAuditRow[];
      return rows.map(rowToRecord);
    },
  };
}
