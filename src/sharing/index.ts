import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  ContractError,
  DEFAULT_SHARING_LEVEL,
  ReasonCode,
  assertDistinctSharingOwners,
  feedIncludes,
  isSharingLevel,
  type AuthPrincipal,
  type FeedItem,
  type FileDownload,
  type ItemKind,
  type SharingDirectory,
  type SharingLevel,
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
 * update is the only public write. The room route audits it. This module does not.
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
    // Match inside this room only, after NFKC. A Greek or Cyrillic look-alike
    // does not fold, so it does not pick up another owner's grant.
    const rows = db
      .prepare<[string], { from_owner_id: string; to_owner_id: string; level: string }>(
        `SELECT from_owner_id, to_owner_id, level FROM sharing WHERE room_id = ?`,
      )
      .all(roomId);
    const row = rows.find(
      (candidate) =>
        sameOwnerId(candidate.from_owner_id, fromOwnerId) && sameOwnerId(candidate.to_owner_id, toOwnerId),
    );
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
    // An empty id is not an owner. The same-owner shortcut must not show it anything.
    if (ownerKey(viewerOwnerId) === "" || ownerKey(authorOwnerId) === "") return false;
    if (held) return false;
    const granted = level(roomId, authorOwnerId, viewerOwnerId);
    return feedIncludes({
      held: false,
      level: granted,
      itemKind,
      viewerOwnerId,
      authorOwnerId,
    });
  }

  function visibleFeed(roomId: string, viewerOwnerId: string): FeedItem[] {
    if (ownerKey(viewerOwnerId) === "") return [];
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
      const metadata = readMetadata(row.metadataJson);
      // Unreadable metadata hides this file. The rest of the feed still returns.
      if (!metadata) continue;
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
          metadata,
          createdAt: row.createdAt,
        },
      });
    }

    visible.sort(byAge);
    return visible.map((entry) => entry.item);
  }

  function visibleFile(roomId: string, fileId: string, viewerOwnerId: string): FileDownload | null {
    if (ownerKey(viewerOwnerId) === "") return null;
    const row = db.prepare<[string, string], FileRow>(FILE_ONE_SQL).get(roomId, fileId);
    if (!row) return null;
    if (!viewerMaySee(row.authorOwnerId, viewerOwnerId, roomId, "file", isHeld(row.held))) {
      return null;
    }
    const metadata = readMetadata(row.metadataJson);
    if (!metadata) return null;

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
      metadata,
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
    // Anything that is not an owner token is refused, even when the owner id matches.
    if (principal.kind !== "owner") {
      const reasonCode = principal.kind === "agent" ? ReasonCode.AgentCannotChangeSharing : ReasonCode.NotOwner;
      return { allowed: false, reasonCode };
    }
    if (!sameOwnerId(principal.ownerId, fromOwnerId)) {
      return { allowed: false, reasonCode: ReasonCode.NotOwner };
    }
    return { allowed: true, sharing: writeLevel(roomId, fromOwnerId, toOwnerId, sharingLevel) };
  }

  return { level, ensurePair, update, visibleFeed, visibleFile };
}

function assertLevel(level: SharingLevel): void {
  if (!isSharingLevel(level)) throw new ContractError("unknown sharing level");
}

/** Only a stored 0 is visible. Any other value, including values outside 0 and 1, is held. */
function isHeld(value: unknown): boolean {
  return value !== 0;
}

/** NFKC, then exact code points. Look-alike letters are not folded. */
function ownerKey(value: string): string {
  return value.normalize("NFKC");
}

function sameOwnerId(left: string, right: string): boolean {
  return ownerKey(left) === ownerKey(right);
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

/** Undefined hides the file. A bad file does not drop the rest of the feed. */
function readMetadata(json: string): Record<string, string> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const metadata: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string") return undefined;
      metadata[key] = item;
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function encodeContent(content: unknown): string {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new ContractError("file content is missing");
  }
  return Buffer.from(content).toString("base64");
}
