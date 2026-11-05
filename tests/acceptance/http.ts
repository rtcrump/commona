import { tokens } from "../../src/auth/index.js";
import {
  HTTP_STATUS,
  type AddMemberRequest,
  type AddMemberResponse,
  type AuditRecord,
  type CreatePostRequest,
  type CreatePostResponse,
  type CreateRoomResponse,
  type FeedItem,
  type FeedResponse,
  type LogResponse,
  type NoticesResponse,
  type OwnerNotice,
  type PutSharingRequest,
  type PutSharingResponse,
  type SharingLevel,
  type UploadFileRequest,
  type UploadFileResponse,
} from "../../contract/index.js";
import type { Ctx } from "./ctx.js";
import { noteEvidence } from "./ctx.js";
import { fail, notBuilt } from "./failure.js";

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRouteMiss(json: unknown): boolean {
  if (!isRecord(json) || typeof json.message !== "string") return false;
  return json.message.startsWith("Route ") && json.message.includes("not found");
}

export async function request(
  ctx: Ctx,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  if (response.status === HTTP_STATUS.notFound && isRouteMiss(json)) {
    notBuilt(`route not registered: ${method} ${path}`);
  }
  if (response.status >= 500 && /TODO\(/.test(text)) {
    notBuilt(text);
  }
  return { status: response.status, text, json };
}

export function ownerToken(ctx: Ctx, ownerId: string): string {
  const cached = ctx.ownerTokens.get(ownerId);
  if (cached) return cached;
  const token = tokens.issueOwnerToken(ownerId);
  ctx.ownerTokens.set(ownerId, token);
  return token;
}

export function agentToken(ctx: Ctx, agentId: string): string {
  const cached = ctx.agentTokens.get(agentId);
  if (cached) return cached;
  const token = tokens.issueAgentToken(agentId);
  ctx.agentTokens.set(agentId, token);
  return token;
}

export async function createRoom(ctx: Ctx, ownerId: string): Promise<string> {
  const res = await request(ctx, "POST", "/rooms", ownerToken(ctx, ownerId));
  if (res.status !== HTTP_STATUS.created) fail(`POST /rooms returned ${res.status}: ${res.text}`);
  const body = res.json as CreateRoomResponse;
  if (!body?.room?.id) fail(`POST /rooms did not return a room: ${res.text}`);
  return body.room.id;
}

export async function addMember(ctx: Ctx, roomId: string, ownerId: string, agentId: string): Promise<void> {
  const body: AddMemberRequest = { agentId };
  const res = await request(ctx, "POST", `/rooms/${roomId}/members`, ownerToken(ctx, ownerId), body);
  if (res.status !== HTTP_STATUS.created && res.status !== HTTP_STATUS.ok) {
    fail(`POST /rooms/${roomId}/members returned ${res.status}: ${res.text}`);
  }
  const parsed = res.json as AddMemberResponse;
  if (parsed?.member?.agentId !== agentId) fail(`membership response did not name ${agentId}: ${res.text}`);
}

export async function postMessage(
  ctx: Ctx,
  roomId: string,
  agentId: string,
  text: string,
  replyToId?: string,
): Promise<CreatePostResponse> {
  const body: CreatePostRequest = replyToId ? { text, replyToId } : { text };
  const res = await request(ctx, "POST", `/rooms/${roomId}/posts`, agentToken(ctx, agentId), body);
  if (res.status !== HTTP_STATUS.created && res.status !== HTTP_STATUS.ok) {
    fail(`POST /rooms/${roomId}/posts returned ${res.status}: ${res.text}`);
  }
  const parsed = res.json as CreatePostResponse;
  if (!parsed?.post?.id || (parsed.outcome !== "accepted" && parsed.outcome !== "held")) {
    fail(`POST /rooms/${roomId}/posts returned an unexpected body: ${res.text}`);
  }
  if (parsed.outcome === "accepted" && res.status !== HTTP_STATUS.created) {
    fail(`accepted post returned HTTP ${res.status}`);
  }
  if (parsed.outcome === "held" && res.status !== HTTP_STATUS.ok) {
    fail(`held post returned HTTP ${res.status}`);
  }
  return parsed;
}

export function fileBody(filename: string, text: string, metadata?: Record<string, string>): UploadFileRequest {
  const body: UploadFileRequest = {
    filename,
    mediaType: "text/markdown",
    contentBase64: Buffer.from(text, "utf8").toString("base64"),
  };
  if (metadata) body.metadata = metadata;
  return body;
}

export async function upload(
  ctx: Ctx,
  roomId: string,
  agentId: string,
  body: UploadFileRequest,
): Promise<UploadFileResponse> {
  const res = await request(ctx, "POST", `/rooms/${roomId}/files`, agentToken(ctx, agentId), body);
  if (res.status !== HTTP_STATUS.created && res.status !== HTTP_STATUS.ok) {
    fail(`POST /rooms/${roomId}/files returned ${res.status}: ${res.text}`);
  }
  const parsed = res.json as UploadFileResponse;
  if (!parsed?.file?.id || (parsed.outcome !== "accepted" && parsed.outcome !== "held")) {
    fail(`POST /rooms/${roomId}/files returned an unexpected body: ${res.text}`);
  }
  if (parsed.outcome === "accepted" && res.status !== HTTP_STATUS.created) {
    fail(`accepted file returned HTTP ${res.status}`);
  }
  if (parsed.outcome === "held" && res.status !== HTTP_STATUS.ok) {
    fail(`held file returned HTTP ${res.status}`);
  }
  return parsed;
}

export async function feed(ctx: Ctx, roomId: string, agentId: string): Promise<FeedItem[]> {
  const res = await request(
    ctx,
    "GET",
    `/rooms/${roomId}/feed?as=${encodeURIComponent(agentId)}`,
    agentToken(ctx, agentId),
  );
  if (res.status !== HTTP_STATUS.ok) fail(`GET feed as ${agentId} returned ${res.status}: ${res.text}`);
  const parsed = res.json as FeedResponse;
  if (!Array.isArray(parsed?.items)) fail(`GET feed did not return items: ${res.text}`);
  return parsed.items;
}

export async function putSharing(
  ctx: Ctx,
  roomId: string,
  token: string,
  body: PutSharingRequest,
): Promise<HttpResult & { sharing?: PutSharingResponse }> {
  const res = await request(ctx, "PUT", `/rooms/${roomId}/sharing`, token, body);
  return res;
}

export async function logFor(ctx: Ctx, ownerId: string, token: string): Promise<AuditRecord[]> {
  const res = await request(ctx, "GET", `/log?owner=${encodeURIComponent(ownerId)}`, token);
  if (res.status !== HTTP_STATUS.ok) fail(`GET /log?owner=${ownerId} returned ${res.status}: ${res.text}`);
  const parsed = res.json as LogResponse;
  if (!Array.isArray(parsed?.entries)) fail(`GET /log did not return entries: ${res.text}`);
  noteEvidence(ctx, parsed.entries);
  return parsed.entries;
}

export async function noticesFor(ctx: Ctx, ownerId: string): Promise<OwnerNotice[]> {
  const res = await request(ctx, "GET", "/notices", ownerToken(ctx, ownerId));
  if (res.status !== HTTP_STATUS.ok) fail(`GET /notices returned ${res.status}: ${res.text}`);
  const parsed = res.json as NoticesResponse;
  if (!Array.isArray(parsed?.notices)) fail(`GET /notices did not return notices: ${res.text}`);
  return parsed.notices;
}

export async function openPair(ctx: Ctx, roomId: string, fromOwnerId: string, toOwnerId: string, level: SharingLevel): Promise<void> {
  const res = await putSharing(ctx, roomId, ownerToken(ctx, fromOwnerId), { fromOwnerId, toOwnerId, level });
  if (res.status !== HTTP_STATUS.ok) {
    fail(`PUT sharing ${fromOwnerId}→${toOwnerId} returned ${res.status}: ${res.text}`);
  }
  const body = res.json as PutSharingResponse;
  if (body?.sharing?.level !== level) fail(`PUT sharing did not store ${level}: ${res.text}`);
}

export function mailsTo(ctx: Ctx, email: string): number {
  return ctx.mail.messages.filter((message) => message.to.includes(email)).length;
}
