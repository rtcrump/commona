import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  ContractError,
  DEFAULT_SHARING_LEVEL,
  ReasonCode,
  SharingLevel,
  assertDistinctSharingOwners,
  feedIncludes,
  isId,
  isSharingLevel,
  type AuthPrincipal,
  type FeedItem,
  type FileDownload,
  type ItemKind,
  type SharingDirectory,
  type SharingRow,
  type SharingUpdateResult,
} from "../../contract/index.js";

/**
 * T3. Per-owner sharing.
 *
 * A row is directional: fromOwnerId grants what toOwnerId's agents may see.
 * The default is None. A missing row, and any stored value outside the three
 * levels, reads as None. ensurePair inserts both directions and does not
 * overwrite. visibleFeed and visibleFile use level(room, author, viewer).
 * Held items stay hidden. A file the viewer must not see looks like a missing file.
 *
 * `update` is the only owner write. The room route audits it. This module does not.
 * `writePolicyMessages` is the room's invite default. It sets Messages on one edge
 * and cannot set files. It does not take an owner principal and does not audit.
 */

export interface SharingAccess extends SharingDirectory {
  visibleFeed(roomId: string, viewerOwnerId: string): FeedItem[];
  /** Null when the file is missing or the viewer must not see it. */
  visibleFile(roomId: string, fileId: string, viewerOwnerId: string): FileDownload | null;
}

interface MessageRow {
  id: string;
  authorAgentId: string;
  authorOwnerId: string;
  text: string;
  replyToId: string | null;
  threadId: string;
  round: number;
  held: number;
  createdAt: string;
}

interface FileRow {
  id: string;
  authorAgentId: string;
  authorOwnerId: string;
  name: string;
  mediaType: string;
  byteLength: number;
  metadataJson: string;
  held: number;
  createdAt: string;
}

const MESSAGE_SQL = `
  SELECT id,
         author_agent_id AS authorAgentId,
         author_owner_id AS authorOwnerId,
         text,
         reply_to_id AS replyToId,
         thread_id AS threadId,
         round,
         held,
         created_at AS createdAt
  FROM posts
  WHERE room_id = ?
`;

const FILE_SQL = `
  SELECT id,
         author_agent_id AS authorAgentId,
         author_owner_id AS authorOwnerId,
         name,
         media_type AS mediaType,
         byte_length AS byteLength,
         metadata_json AS metadataJson,
         held,
         created_at AS createdAt
  FROM files
  WHERE room_id = ?
`;

const FILE_ONE_SQL = `${FILE_SQL} AND id = ?`;

export function createSharingDirectory(db: SqliteDatabase): SharingAccess {
  function level(roomId: string, fromOwnerId: string, toOwnerId: string): SharingLevel {
    const row = db
      .prepare<[string, string, string], { level: string }>(
        `SELECT level FROM sharing
         WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?`,
      )
      .get(roomId, fromOwnerId, toOwnerId);
    if (!row || !isSharingLevel(row.level)) return DEFAULT_SHARING_LEVEL;
    return row.level;
  }

  function ensurePair(roomId: string, ownerA: string, ownerB: string): void {
    assertDistinctSharingOwners(ownerA, ownerB);
    const insert = db.prepare(
      `INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, from_owner_id, to_owner_id) DO NOTHING`,
    );
    const write = db.transaction(() => {
      insert.run(roomId, ownerA, ownerB, DEFAULT_SHARING_LEVEL);
      insert.run(roomId, ownerB, ownerA, DEFAULT_SHARING_LEVEL);
    });
    write();
  }

  function writeLevel(
    roomId: string,
    fromOwnerId: string,
    toOwnerId: string,
    sharingLevel: SharingLevel,
  ): SharingRow {
    assertDistinctSharingOwners(fromOwnerId, toOwnerId);
    assertLevel(sharingLevel);
    db.prepare(
      `INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, from_owner_id, to_owner_id)
       DO UPDATE SET level = excluded.level`,
    ).run(roomId, fromOwnerId, toOwnerId, sharingLevel);
    return { roomId, fromOwnerId, toOwnerId, level: sharingLevel };
  }

  function viewerMaySee(
    authorOwnerId: string,
    viewerOwnerId: string,
    roomId: string,
    itemKind: ItemKind,
    held: boolean,
  ): boolean {
    const granted = level(roomId, authorOwnerId, viewerOwnerId);
    return feedIncludes({
      held,
      level: granted,
      itemKind,
      viewerOwnerId,
      authorOwnerId,
    });
  }

  function visibleFeed(roomId: string, viewerOwnerId: string): FeedItem[] {
    const messages = db.prepare<[string], MessageRow>(MESSAGE_SQL).all(roomId);
    const files = db.prepare<[string], FileRow>(FILE_SQL).all(roomId);
    const visible: Array<{ createdAt: string; id: string; item: FeedItem }> = [];

    for (const row of messages) {
      if (!viewerMaySee(row.authorOwnerId, viewerOwnerId, roomId, "message", isHeld(row.held))) {
        continue;
      }
      visible.push({
        createdAt: row.createdAt,
        id: row.id,
        item: {
          kind: "message",
          id: row.id,
          authorAgentId: row.authorAgentId,
          authorOwnerId: row.authorOwnerId,
          text: row.text,
          replyToId: row.replyToId,
          threadId: row.threadId,
          round: row.round,
          createdAt: row.createdAt,
        },
      });
    }

    for (const row of files) {
      if (!viewerMaySee(row.authorOwnerId, viewerOwnerId, roomId, "file", isHeld(row.held))) {
        continue;
      }
      visible.push({
        createdAt: row.createdAt,
        id: row.id,
        item: {
          kind: "file",
          id: row.id,
          authorAgentId: row.authorAgentId,
          authorOwnerId: row.authorOwnerId,
          name: row.name,
          mediaType: row.mediaType,
          byteLength: row.byteLength,
          metadata: readMetadata(row.metadataJson),
          createdAt: row.createdAt,
        },
      });
    }

    visible.sort(byAge);
    return visible.map((entry) => entry.item);
  }

  function visibleFile(roomId: string, fileId: string, viewerOwnerId: string): FileDownload | null {
    const row = db.prepare<[string, string], FileRow>(FILE_ONE_SQL).get(roomId, fileId);
    if (!row) return null;
    if (!viewerMaySee(row.authorOwnerId, viewerOwnerId, roomId, "file", isHeld(row.held))) {
      return null;
    }

    const blob = db
      .prepare<[string, string], { content: unknown }>(
        "SELECT content FROM files WHERE room_id = ? AND id = ?",
      )
      .get(roomId, fileId);
    if (!blob) return null;

    return {
      id: row.id,
      roomId,
      authorAgentId: row.authorAgentId,
      authorOwnerId: row.authorOwnerId,
      name: row.name,
      mediaType: row.mediaType,
      byteLength: row.byteLength,
      metadata: readMetadata(row.metadataJson),
      held: isHeld(row.held),
      createdAt: row.createdAt,
      contentBase64: encodeContent(blob.content),
    };
  }

  function update(
    principal: AuthPrincipal,
    roomId: string,
    fromOwnerId: string,
    toOwnerId: string,
    sharingLevel: SharingLevel,
  ): SharingUpdateResult {
    // A bad pair or level is malformed. The route answers 400 and does not audit.
    assertDistinctSharingOwners(fromOwnerId, toOwnerId);
    assertLevel(sharingLevel);
    // Agent tokens are refused even when the agent belongs to fromOwnerId.
    if (principal.kind === "agent") {
      return { allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing };
    }
    if (principal.ownerId !== fromOwnerId) {
      return { allowed: false, reasonCode: ReasonCode.NotOwner };
    }
    return { allowed: true, sharing: writeLevel(roomId, fromOwnerId, toOwnerId, sharingLevel) };
  }

  return { level, ensurePair, update, visibleFeed, visibleFile };
}

function assertLevel(level: SharingLevel): void {
  if (!isSharingLevel(level)) throw new ContractError("unknown sharing level");
}

function isHeld(value: number): boolean {
  return value !== 0;
}

function byAge(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function readMetadata(json: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ContractError("file metadata is not json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError("file metadata must be an object");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new ContractError("file metadata values must be strings");
    metadata[key] = item;
  }
  return metadata;
}

function encodeContent(content: unknown): string {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new ContractError("file content is missing");
  }
  return Buffer.from(content).toString("base64");
}

/**
 * Room default for an invite join. One edge, Messages only.
 * This is not an owner action: the caller audits it as the room policy.
 */
export function writePolicyMessages(
  db: SqliteDatabase,
  roomId: string,
  fromOwnerId: string,
  toOwnerId: string,
): SharingRow {
  assertDistinctSharingOwners(fromOwnerId, toOwnerId);
  if (!isId(roomId) || !isId(fromOwnerId) || !isId(toOwnerId)) {
    throw new ContractError("policy share requires ids");
  }
  db.prepare(
    `INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (room_id, from_owner_id, to_owner_id)
     DO UPDATE SET level = excluded.level`,
  ).run(roomId, fromOwnerId, toOwnerId, SharingLevel.Messages);
  return { roomId, fromOwnerId, toOwnerId, level: SharingLevel.Messages };
}
