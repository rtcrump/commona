import {
  AuditAction,
  AuditResult,
  feedIncludes,
  isAgentId,
  isId,
  MAX_FILE_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_METADATA_CHARS,
  MAX_METADATA_KEYS,
  newId,
  ownerActorId,
  ReasonCode,
  roundForPost,
  TEXT_MEDIA_TYPE_PREFIX,
  TEXT_MEDIA_TYPES,
  wakeSuppressed,
  type AuthPrincipal,
  type CreatePostResponse,
  type FeedItem,
  type FeedResponse,
  type FileDownload,
  type GuardHit,
  type HeldItem,
  type HeldResponse,
  type Post,
  type RoomFile,
  type UploadFileResponse,
} from "../../contract/index.js";
import { nowStamp, refuse, requireMember, requireRoom } from "./access.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";

interface PostRow {
  id: string;
  room_id: string;
  author_agent_id: string;
  author_owner_id: string;
  text: string;
  reply_to_id: string | null;
  thread_id: string;
  round: number;
  held: number;
  block_category: GuardHit["category"] | null;
  block_location: GuardHit["location"] | null;
  created_at: string;
}

interface FileRow {
  id: string;
  room_id: string;
  author_agent_id: string;
  author_owner_id: string;
  name: string;
  media_type: string;
  content: Buffer;
  metadata_json: string;
  byte_length: number;
  held: number;
  block_category: GuardHit["category"] | null;
  block_location: GuardHit["location"] | null;
  created_at: string;
}

export function createPost(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  body: unknown,
): CreatePostResponse {
  const request = parsePost(body);
  requireMember(deps, principal, roomId);
  if (principal.kind !== "agent") throw RoomHttpError.forbidden();
  const parent = resolveParent(deps, roomId, request.replyToId);
  const id = newId("post");
  const round = roundForPost({ authorKind: "agent", parentRound: parent?.round ?? null });
  const threadId = parent?.threadId ?? id;
  const createdAt = nowStamp(deps);
  const decision = deps.guard.check({ kind: "message", text: request.text });
  const held = decision.outcome === "block";
  const block = held ? decision.hits[0] : undefined;
  deps.db
    .prepare(
      `INSERT INTO posts (
        id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
        block_category, block_location, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      principal.agentId,
      principal.ownerId,
      request.text,
      request.replyToId,
      threadId,
      round,
      held ? 1 : 0,
      block?.category ?? null,
      block?.location ?? null,
      createdAt,
    );
  const post: Post = {
    id,
    roomId,
    authorAgentId: principal.agentId,
    authorOwnerId: principal.ownerId,
    text: request.text,
    replyToId: request.replyToId,
    threadId,
    round,
    held,
    createdAt,
  };
  if (held) {
    deps.audit.append({
      ts: nowStamp(deps),
      room: roomId,
      agentId: principal.agentId,
      ownerId: principal.ownerId,
      action: AuditAction.Block,
      result: AuditResult.Blocked,
      detail: {
        ...(block ? { category: block.category, location: block.location } : {}),
        itemKind: "message",
        itemId: id,
        round,
      },
    });
    return block ? { outcome: "held", post, block } : { outcome: "held", post };
  }
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    action: AuditAction.Post,
    result: AuditResult.Ok,
    detail: { itemKind: "message", itemId: id, round },
  });
  enqueueWake(deps, {
    roomId,
    authorAgentId: principal.agentId,
    authorOwnerId: principal.ownerId,
    itemKind: "message",
    itemId: id,
    round,
  });
  return { outcome: "accepted", post };
}

export function uploadFile(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  body: unknown,
): UploadFileResponse {
  const request = parseFile(body);
  requireMember(deps, principal, roomId);
  if (principal.kind !== "agent") throw RoomHttpError.forbidden();
  const bytes = decodeBase64(request.contentBase64);
  const metadata = request.metadata;
  const text = scannedText(request.mediaType, bytes);
  const decision = deps.guard.check({
    kind: "file",
    fileName: request.filename,
    metadata,
    ...(text !== undefined ? { text } : {}),
  });
  const held = decision.outcome === "block";
  const block = held ? decision.hits[0] : undefined;
  const id = newId("file");
  const createdAt = nowStamp(deps);
  const round = 1;
  deps.db
    .prepare(
      `INSERT INTO files (
        id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
        byte_length, held, block_category, block_location, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      principal.agentId,
      principal.ownerId,
      request.filename,
      request.mediaType,
      bytes,
      JSON.stringify(metadata),
      bytes.length,
      held ? 1 : 0,
      block?.category ?? null,
      block?.location ?? null,
      createdAt,
    );
  const file: RoomFile = {
    id,
    roomId,
    authorAgentId: principal.agentId,
    authorOwnerId: principal.ownerId,
    name: request.filename,
    mediaType: request.mediaType,
    byteLength: bytes.length,
    metadata,
    held,
    createdAt,
  };
  if (held) {
    deps.audit.append({
      ts: nowStamp(deps),
      room: roomId,
      agentId: principal.agentId,
      ownerId: principal.ownerId,
      action: AuditAction.Block,
      result: AuditResult.Blocked,
      detail: {
        ...(block ? { category: block.category, location: block.location } : {}),
        itemKind: "file",
        itemId: id,
      },
    });
    return block ? { outcome: "held", file, block } : { outcome: "held", file };
  }
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    action: AuditAction.Upload,
    result: AuditResult.Ok,
    detail: { itemKind: "file", itemId: id },
  });
  enqueueWake(deps, {
    roomId,
    authorAgentId: principal.agentId,
    authorOwnerId: principal.ownerId,
    itemKind: "file",
    itemId: id,
    round,
  });
  return { outcome: "accepted", file };
}

export function readFeed(
  deps: RoomDeps,
  principal: AuthPrincipal,
  roomId: string,
  asAgentId: string | undefined,
): FeedResponse {
  if (!isId(roomId)) throw RoomHttpError.badRequest();
  requireRoom(deps, roomId);
  if (principal.kind !== "agent") {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.JoinRefused,
      reasonCode: ReasonCode.NotMember,
    });
  }
  requireMember(deps, principal, roomId);
  if (asAgentId !== undefined) {
    if (!isAgentId(asAgentId)) throw RoomHttpError.badRequest();
    if (asAgentId !== principal.agentId) {
      refuse(deps, {
        room: roomId,
        principal,
        action: AuditAction.Read,
      });
    }
  }
  const viewerOwnerId = principal.ownerId;
  const items = [
    ...loadMessages(deps, roomId).filter((item) => visible(deps, roomId, item, viewerOwnerId)),
    ...loadFiles(deps, roomId).filter((item) => visible(deps, roomId, item, viewerOwnerId)),
  ].sort(byAge);
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    action: AuditAction.Read,
    result: AuditResult.Ok,
    detail: {},
  });
  return { items };
}

export function readFile(deps: RoomDeps, principal: AuthPrincipal, roomId: string, fileId: string): FileDownload {
  if (!isId(roomId) || !isId(fileId)) throw RoomHttpError.badRequest();
  requireMember(deps, principal, roomId);
  if (principal.kind !== "agent") throw RoomHttpError.notFound();
  const row = deps.db.prepare("SELECT * FROM files WHERE id = ? AND room_id = ?").get(fileId, roomId) as
    | FileRow
    | undefined;
  if (!row || row.held === 1) throw RoomHttpError.notFound();
  const item = fileItem(row);
  if (!visible(deps, roomId, item, principal.ownerId)) throw RoomHttpError.notFound();
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    action: AuditAction.Read,
    result: AuditResult.Ok,
    detail: { itemKind: "file", itemId: row.id },
  });
  return { ...fileRecord(row), contentBase64: asBuffer(row.content).toString("base64") };
}

export function readHeld(deps: RoomDeps, principal: AuthPrincipal, roomId: string): HeldResponse {
  if (!isId(roomId)) throw RoomHttpError.badRequest();
  requireRoom(deps, roomId);
  if (principal.kind !== "owner") {
    refuse(deps, {
      room: roomId,
      principal,
      action: AuditAction.Read,
      reasonCode: "not_owner",
    });
  }
  const items: HeldItem[] = [];
  const posts = deps.db
    .prepare("SELECT * FROM posts WHERE room_id = ? AND held = 1 AND author_owner_id = ? ORDER BY created_at, id")
    .all(roomId, principal.ownerId) as PostRow[];
  for (const row of posts) {
    const block = hitOf(row);
    if (!block) continue;
    items.push({ kind: "message", id: row.id, text: row.text, createdAt: row.created_at, block });
  }
  const files = deps.db
    .prepare("SELECT * FROM files WHERE room_id = ? AND held = 1 AND author_owner_id = ? ORDER BY created_at, id")
    .all(roomId, principal.ownerId) as FileRow[];
  for (const row of files) {
    const block = hitOf(row);
    if (!block) continue;
    items.push({
      kind: "file",
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      metadata: parseMetadataJson(row.metadata_json),
      contentBase64: asBuffer(row.content).toString("base64"),
      createdAt: row.created_at,
      block,
    });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  deps.audit.append({
    ts: nowStamp(deps),
    room: roomId,
    agentId: ownerActorId(principal.ownerId),
    ownerId: principal.ownerId,
    action: AuditAction.Read,
    result: AuditResult.Ok,
    detail: {},
  });
  return { items };
}

function enqueueWake(
  deps: RoomDeps,
  input: {
    roomId: string;
    authorAgentId: string;
    authorOwnerId: string;
    itemKind: "message" | "file";
    itemId: string;
    round: number;
  },
): void {
  if (!deps.wakeQueue || wakeSuppressed(input.round)) return;
  deps.wakeQueue.enqueue(input);
}

function visible(
  deps: RoomDeps,
  roomId: string,
  item: FeedItem,
  viewerOwnerId: string,
): boolean {
  const level = deps.sharing.level(roomId, item.authorOwnerId, viewerOwnerId);
  return feedIncludes({
    held: false,
    level,
    itemKind: item.kind === "message" ? "message" : "file",
    viewerOwnerId,
    authorOwnerId: item.authorOwnerId,
  });
}

function byAge(a: FeedItem, b: FeedItem): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function loadMessages(deps: RoomDeps, roomId: string): FeedItem[] {
  const rows = deps.db
    .prepare("SELECT * FROM posts WHERE room_id = ? AND held = 0 ORDER BY created_at, id")
    .all(roomId) as PostRow[];
  return rows.map((row) => ({
    kind: "message" as const,
    id: row.id,
    authorAgentId: row.author_agent_id,
    authorOwnerId: row.author_owner_id,
    text: row.text,
    replyToId: row.reply_to_id,
    threadId: row.thread_id,
    round: row.round,
    createdAt: row.created_at,
  }));
}

function loadFiles(deps: RoomDeps, roomId: string): FeedItem[] {
  const rows = deps.db
    .prepare("SELECT * FROM files WHERE room_id = ? AND held = 0 ORDER BY created_at, id")
    .all(roomId) as FileRow[];
  return rows.map(fileItem);
}

function fileItem(row: FileRow): FeedItem {
  return {
    kind: "file",
    id: row.id,
    authorAgentId: row.author_agent_id,
    authorOwnerId: row.author_owner_id,
    name: row.name,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    metadata: parseMetadataJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function fileRecord(row: FileRow): RoomFile {
  return {
    id: row.id,
    roomId: row.room_id,
    authorAgentId: row.author_agent_id,
    authorOwnerId: row.author_owner_id,
    name: row.name,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    metadata: parseMetadataJson(row.metadata_json),
    held: row.held === 1,
    createdAt: row.created_at,
  };
}

function hitOf(row: { block_category: GuardHit["category"] | null; block_location: GuardHit["location"] | null }): GuardHit | undefined {
  if (!row.block_category || !row.block_location) return undefined;
  return { category: row.block_category, location: row.block_location };
}

function parseMetadataJson(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function parsePost(body: unknown): { text: string; replyToId: string | null } {
  if (!isRecord(body) || typeof body.text !== "string") throw RoomHttpError.badRequest();
  if (body.text.length === 0 || body.text.length > MAX_MESSAGE_CHARS) throw RoomHttpError.badRequest();
  const reply = body.replyToId;
  if (reply !== undefined && reply !== null && typeof reply !== "string") throw RoomHttpError.badRequest();
  if (typeof reply === "string" && !isId(reply)) throw RoomHttpError.badRequest();
  return { text: body.text, replyToId: typeof reply === "string" ? reply : null };
}

function resolveParent(
  deps: RoomDeps,
  roomId: string,
  replyToId: string | null,
): { threadId: string; round: number } | null {
  if (!replyToId) return null;
  const parent = deps.db.prepare("SELECT thread_id, round, room_id FROM posts WHERE id = ?").get(replyToId) as
    | { thread_id: string; round: number; room_id: string }
    | undefined;
  if (!parent || parent.room_id !== roomId) throw RoomHttpError.badRequest();
  return { threadId: parent.thread_id, round: parent.round };
}

interface FileRequest {
  filename: string;
  mediaType: string;
  contentBase64: string;
  metadata: Record<string, string>;
}

function parseFile(body: unknown): FileRequest {
  if (!isRecord(body)) throw RoomHttpError.badRequest();
  if (typeof body.filename !== "string" || body.filename.length === 0) throw RoomHttpError.badRequest();
  if (typeof body.mediaType !== "string" || body.mediaType.length === 0) throw RoomHttpError.badRequest();
  if (typeof body.contentBase64 !== "string") throw RoomHttpError.badRequest();
  return {
    filename: body.filename,
    mediaType: body.mediaType,
    contentBase64: body.contentBase64,
    metadata: parseMetadata(body.metadata),
  };
}

function parseMetadata(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw RoomHttpError.badRequest();
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) throw RoomHttpError.badRequest();
  const out: Record<string, string> = {};
  for (const key of keys) {
    const item = value[key];
    if (typeof item !== "string") throw RoomHttpError.badRequest();
    if (key.length > MAX_METADATA_CHARS || item.length > MAX_METADATA_CHARS) throw RoomHttpError.badRequest();
    out[key] = item;
  }
  return out;
}

function decodeBase64(value: string): Buffer {
  if (value.startsWith("data:")) throw RoomHttpError.badRequest();
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw RoomHttpError.badRequest();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw RoomHttpError.badRequest();
  return bytes;
}

function scannedText(mediaType: string, bytes: Buffer): string | undefined {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const textual = base.startsWith(TEXT_MEDIA_TYPE_PREFIX) || (TEXT_MEDIA_TYPES as readonly string[]).includes(base);
  if (!textual) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
