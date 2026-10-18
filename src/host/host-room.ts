import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  UNSCOPED_ROOM,
} from "../../contract/index.js";
import { ensureInviteSchema } from "../join/schema.js";
import { createInvite } from "../join/service.js";
import { openAccount } from "../onboarding/account.js";
import type { CommonaEnv, DirectoryStub } from "../env.js";
import type { RoomDeps } from "../room/deps.js";
import { rememberHostGrant } from "../room/host-grant.js";
import { RoomHttpError } from "../room/http.js";
import { addMember, createRoom } from "../room/membership.js";
import type { AppEnv } from "../http/types.js";

const LABEL_MAX = 80;
const MAX_INVITE_COUNT = 20;
const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const SECRET_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * Sent by room:new. The value is compared and then dropped.
 * It is never written to a log, an audit detail, or a response.
 */
export const HOST_SECRET_HEADER = "x-commona-host-secret";

/**
 * Set by the Worker only after the secret compare fails.
 * Caller requests have this header removed before any room code runs.
 */
export const HOST_REFUSAL_HEADER = "x-commona-host-refusal";

const DUMMY = new Uint8Array(32);

let requestSecret: string | undefined;

class HostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostInputError";
  }
}

/**
 * The secret for this request. The Worker sets it from the binding.
 * Node tests leave it unset and the process environment is used instead.
 * An empty binding is an empty string, which never matches.
 */
export function configuredHostSecret(): string {
  if (requestSecret !== undefined) return requestSecret;
  const fromEnv = process.env.COMMONA_HOST_SECRET;
  return typeof fromEnv === "string" ? fromEnv : "";
}

/** Hold the binding for one Durable Object request. Do not copy it into process.env. */
export async function useHostSecret<T>(secret: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = requestSecret;
  requestSecret = secret ?? "";
  try {
    return await run();
  } finally {
    requestSecret = previous;
  }
}

/**
 * Constant-time compare. A missing or empty expected secret always refuses,
 * including when the presented value is also empty.
 */
export function hostSecretsMatch(presented: string, expected: string): boolean {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  if (expected.length === 0) {
    timingSafeEqual(DUMMY, DUMMY);
    return false;
  }
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Drop the internal refusal header so a caller cannot set it. */
export function stripInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(HOST_REFUSAL_HEADER);
  return new Request(request, { headers });
}

/**
 * Worker entry for every request except the health check, which the Worker
 * answers itself. A failed secret compare never creates a room. It asks the
 * directory to append a refusal, and the presented secret is not forwarded.
 */
export async function handleWorkerRequest(request: Request, env: CommonaEnv, directory: DirectoryStub): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "commona" });
  }
  const clean = stripInternalHeaders(request);
  if (request.method === "POST" && url.pathname === "/host/room") {
    const presented = clean.headers.get(HOST_SECRET_HEADER) ?? "";
    if (!hostSecretsMatch(presented, env.COMMONA_HOST_SECRET ?? "")) {
      const refusal = new Request(clean.url, {
        method: "POST",
        headers: { [HOST_REFUSAL_HEADER]: "1" },
      });
      return directory.fetch(refusal);
    }
  }
  return directory.fetch(clean);
}

/** Append one refusal. The detail is empty so the secret cannot land in the log. */
export function auditHostRefusal(deps: RoomDeps): void {
  deps.audit.append({
    ts: formatTimestamp(deps.clock.now()),
    room: UNSCOPED_ROOM,
    agentId: "owner:host",
    ownerId: "host",
    action: AuditAction.JoinRefused,
    result: AuditResult.Refused,
    detail: {},
  });
}

/** True when the Worker has already decided this call is a refusal. */
export function isHostRefusal(request: Request): boolean {
  return request.headers.get(HOST_REFUSAL_HEADER) === "1";
}

interface HostRoomBody {
  title: string;
  hostName: string;
  inviteCount: number;
}

interface HostRoomResult {
  invites: string[];
  credential: string;
  roomId: string;
  agentId: string;
}

/**
 * `POST /host/room` on the public server. The route checks the secret again.
 * Forwarded headers are ignored: Cloudflare sets them on every request, and
 * they do not grant or deny this call.
 */
export function registerHostRoute(app: Hono<AppEnv>, deps: RoomDeps): void {
  app.post("/host/room", (c) => {
    const presented = c.req.header(HOST_SECRET_HEADER) ?? "";
    const expected = configuredHostSecret();
    if (!hostSecretsMatch(presented, expected)) {
      auditHostRefusal(deps);
      return jsonNoStore(c, RoomHttpError.forbidden().body(), 403);
    }
    try {
      const body = readBody(c.get("parsedBody"));
      const origin = requireHttpsOrigin(process.env.COMMONA_PUBLIC_ORIGIN);
      const created = createHostedRoom(deps, body, origin, expected);
      return jsonNoStore(c, created, 201);
    } catch (error) {
      if (error instanceof HostInputError) return jsonNoStore(c, { error: { message: error.message } }, 400);
      if (error instanceof RoomHttpError) return jsonNoStore(c, error.body(), error.status);
      return jsonNoStore(c, { error: { message: "room:new failed" } }, 500);
    }
  });
}

function jsonNoStore(c: Context<AppEnv>, body: unknown, status: number): Response {
  return c.json(body, status as 200, { "cache-control": "no-store" });
}

function createHostedRoom(deps: RoomDeps, body: HostRoomBody, origin: string, hostSecret: string): HostRoomResult {
  const write = deps.db.transaction(() => {
    ensureInviteSchema(deps.db);
    const opened = openAccount(deps.db, deps.tokens);
    deps.db.prepare("UPDATE owners SET display_name = ? WHERE id = ?").run(body.hostName, opened.ownerId);
    const principal = { kind: "owner" as const, ownerId: opened.ownerId };
    const room = createRoom(deps, principal);
    addMember(deps, principal, room.id, opened.agentId);
    deps.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.id, body.title);
    const invites: string[] = [];
    for (let index = 0; index < body.inviteCount; index += 1) {
      const created = createInvite(deps, principal, room.id, {});
      invites.push(`${origin}/j/${created.id}/${created.secret}`);
    }
    const credential = deps.tokens.issueAgentToken(opened.agentId);
    rememberHostGrant(deps.db, room.id, opened.ownerId);
    assertClean(deps, invites, credential, [credential, opened.sessionToken, hostSecret]);
    if (room.id.includes(credential) || opened.agentId.includes(credential)) {
      throw new HostInputError("room:new failed");
    }
    return { invites, credential, roomId: room.id, agentId: opened.agentId };
  });
  return write();
}

function assertClean(deps: RoomDeps, invites: readonly string[], credential: string, hidden: readonly string[]): void {
  const details = deps.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  const auditText = details.map((row) => row.detail_json).join("\n");
  for (const secret of hidden) {
    if (!secret || !SECRET_CHARSET.test(secret)) throw new HostInputError("room:new failed");
    if (invites.some((url) => url.includes(secret)) || auditText.includes(secret)) {
      throw new HostInputError("room:new failed");
    }
  }
  for (const other of hidden.slice(1)) {
    if (other.length > 0 && credential.includes(other)) throw new HostInputError("room:new failed");
  }
  for (const url of invites) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostInputError("room:new failed");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new HostInputError("room:new failed");
    }
  }
}

function requireHttpsOrigin(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!HTTPS_ORIGIN.test(value)) {
    throw new HostInputError("COMMONA_PUBLIC_ORIGIN must be an https origin");
  }
  return value;
}

function readBody(body: unknown): HostRoomBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HostInputError("Invalid request.");
  }
  const title = (body as { title?: unknown }).title;
  const hostName = (body as { hostName?: unknown }).hostName;
  const inviteCount = (body as { inviteCount?: unknown }).inviteCount;
  if (typeof title !== "string" || typeof hostName !== "string" || typeof inviteCount !== "number") {
    throw new HostInputError("Invalid request.");
  }
  return {
    title: requireLabel(title, "room title must be a short label"),
    hostName: requireLabel(hostName, "host display name must be a short label"),
    inviteCount: requireCount(inviteCount),
  };
}

function requireLabel(raw: string, shapeMessage: string): string {
  const label = raw.trim();
  if (!label || label.length > LABEL_MAX || /[\r\n<>]/.test(label)) {
    throw new HostInputError(shapeMessage);
  }
  return label;
}

function requireCount(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INVITE_COUNT) {
    throw new HostInputError("invite count must be a whole number from 1 to 20");
  }
  return count;
}
