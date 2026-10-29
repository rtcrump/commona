import { timingSafeEqual } from "node:crypto";
import {
  hashToken,
  HTTP_STATUS,
  isId,
  readBearerToken,
  type AuthPrincipal,
  type CreatePostResponse,
} from "../../contract/index.js";
import { normalizeOrigin, PUBLIC_ORIGIN_MESSAGE, PublicOriginError, publicOrigin } from "../http/public-origin.js";
import type { CommonaHono } from "../http/types.js";
import { isInviteId, redeemInvite } from "../join/service.js";
import { ensureInviteSchema } from "../join/schema.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { createPost } from "../room/posts.js";
import { recentMessages } from "../room-page/messages.js";
import { isRevokedAgentKey, revokeAgentKey } from "./keys.js";
import { ensureAgentApiSchema } from "./schema.js";

/**
 * JSON room API. It mirrors the plain HTML page: join with one invite, read posts, post a message.
 * The agent key is a bearer token. Only its SHA-256 hash is stored.
 * The redeem response also returns a narrow sharing key once, and the absolute
 * addresses for posting, reading the room, reading the room feed, and changing
 * sharing. It does not return the owner session token.
 * Only GET redeems an invite. Hono would otherwise run HEAD through this GET handler.
 */
export function registerAgentApi(app: CommonaHono, deps: RoomDeps): void {
  ensureInviteSchema(deps.db);
  ensureAgentApiSchema(deps.db);

  app.get("/api/j/:inviteId/:secret", (c) => {
    if (c.req.method !== "GET") {
      return json({ error: { code: "validation", message: "Open this invite with GET." } }, HTTP_STATUS.ok);
    }
    const origin = joinOrigin(c.req.url, c.req.header("host"));
    if (origin instanceof Response) return origin;
    return redeemAndReturn(deps, undefined, c.req.param("inviteId"), c.req.param("secret"), origin);
  });

  app.get("/api/r/:room/:inviteId/:secret", (c) =>
    handleRead(deps, {
      method: c.req.method,
      roomId: c.req.param("room"),
      inviteId: c.req.param("inviteId"),
      secret: c.req.param("secret"),
      authorization: c.req.header("authorization"),
      requestUrl: c.req.url,
      host: c.req.header("host"),
    }),
  );
  app.get("/api/r/:room", (c) =>
    handleRead(deps, {
      method: c.req.method,
      roomId: c.req.param("room"),
      inviteId: null,
      secret: c.req.query("t") ?? null,
      authorization: c.req.header("authorization"),
      requestUrl: c.req.url,
      host: c.req.header("host"),
    }),
  );
  app.post("/api/r/:room", (c) => handlePost(deps, c.req.param("room"), c.req.header("authorization"), c.get("parsedBody")));
  app.delete("/api/r/:room/agents/:agentId", (c) =>
    handleRevoke(deps, c.req.param("room"), c.req.param("agentId"), c.req.header("authorization")),
  );
}

function joinOrigin(url: string, host: string | undefined): string | Response {
  try {
    return publicOrigin(url, host);
  } catch (error) {
    if (error instanceof PublicOriginError) return originRejected();
    throw error;
  }
}

function originRejected(): Response {
  return json({ error: { code: "validation", message: PUBLIC_ORIGIN_MESSAGE } }, HTTP_STATUS.badRequest);
}

function addressesBeforeRedeem(
  deps: RoomDeps,
  roomHint: string | undefined,
  inviteId: string,
  origin: string,
): { roomId: string; addresses: ReturnType<typeof joinAddresses> } | Response | undefined {
  const roomId = roomIdBeforeRedeem(deps, roomHint, inviteId);
  if (!roomId) return undefined;
  try {
    return { roomId, addresses: joinAddresses(origin, roomId) };
  } catch (error) {
    if (error instanceof Error && error.message === "refusing to send an address") return originRejected();
    throw error;
  }
}

function roomIdBeforeRedeem(deps: RoomDeps, roomHint: string | undefined, inviteId: string): string | null {
  ensureInviteSchema(deps.db);
  if (!isInviteId(inviteId)) return null;
  const row = deps.db.prepare("SELECT room_id FROM invites WHERE id = ?").get(inviteId) as
    | { room_id: string }
    | undefined;
  if (!row || !isId(row.room_id)) return null;
  if (roomHint !== undefined && roomHint !== row.room_id) return null;
  return row.room_id;
}

function handleRead(
  deps: RoomDeps,
  input: {
    method: string;
    roomId: string;
    inviteId: string | null;
    secret: string | null;
    authorization: string | undefined;
    requestUrl: string;
    host: string | undefined;
  },
): Response {
  if (input.method !== "GET") {
    return json({ error: { code: "validation", message: "Open this invite with GET." } }, HTTP_STATUS.ok);
  }
  if (!isId(input.roomId) || !roomExists(deps, input.roomId)) {
    return json(RoomHttpError.notFound().body(), HTTP_STATUS.notFound);
  }
  const secret = input.secret && input.secret.length > 0 ? input.secret : null;
  if (secret) {
    const origin = joinOrigin(input.requestUrl, input.host);
    if (origin instanceof Response) return origin;
    return redeemAndReturn(deps, input.roomId, input.inviteId, secret, origin);
  }
  return readForBearer(deps, input.roomId, input.authorization);
}

function redeemAndReturn(
  deps: RoomDeps,
  roomHint: string | undefined,
  inviteId: string | null,
  secret: string,
  origin: string,
): Response {
  const id = inviteId ?? (roomHint === undefined ? null : inviteIdForSecret(deps, roomHint, secret));
  if (!id) return json(RoomHttpError.forbidden().body(), HTTP_STATUS.forbidden);
  // Addresses are checked before redeem. A bad origin must fail while the invite is still unused.
  const prepared = addressesBeforeRedeem(deps, roomHint, id, origin);
  if (prepared instanceof Response) return prepared;
  let redeemed;
  try {
    redeemed = redeemInvite(deps, id, secret, roomHint, { defaultRoomPosts: true });
  } catch (error) {
    if (error instanceof RoomHttpError) return json(error.body(), error.status);
    throw error;
  }
  const roomId = redeemed.member.roomId;
  const addresses = prepared?.roomId === roomId ? prepared.addresses : joinAddresses(origin, roomId);
  const principal: AuthPrincipal = {
    kind: "agent",
    agentId: redeemed.agent.id,
    ownerId: redeemed.owner.id,
  };
  const agentKey = deps.tokens.issueAgentToken(redeemed.agent.id);
  const sharingKey = deps.tokens.issueNarrowToken(redeemed.owner.id);
  const sessionToken = redeemed.sessionToken;
  if (!/^[A-Za-z0-9_-]+$/.test(agentKey) || !/^[A-Za-z0-9_-]+$/.test(sharingKey)) {
    throw new Error("refusing to send a secret");
  }
  const body = {
    roomId,
    agentId: principal.agentId,
    ownerId: principal.ownerId,
    title: roomTitle(deps, roomId),
    posts: recentPosts(deps, principal, roomId),
    agentKey,
    sharingKey,
    addresses,
  };
  assertHidden(
    JSON.stringify({
      roomId: body.roomId,
      agentId: body.agentId,
      ownerId: body.ownerId,
      title: body.title,
      posts: body.posts,
      addresses: body.addresses,
    }),
    [secret, agentKey, sharingKey, sessionToken],
  );
  const encoded = JSON.stringify(body);
  assertHidden(encoded, [secret, sessionToken, hashToken(agentKey), hashToken(sharingKey), hashToken(sessionToken)]);
  return json(body, HTTP_STATUS.ok);
}

function readForBearer(deps: RoomDeps, roomId: string, authorization: string | undefined): Response {
  const principal = requireAgent(deps, authorization);
  const body = {
    roomId,
    title: roomTitle(deps, roomId),
    posts: recentPosts(deps, principal, roomId),
  };
  return json(body, HTTP_STATUS.ok);
}

function handlePost(deps: RoomDeps, roomId: string, authorization: string | undefined, body: unknown): Response {
  if (!isId(roomId) || !roomExists(deps, roomId)) {
    return json(RoomHttpError.notFound().body(), HTTP_STATUS.notFound);
  }
  const principal = requireAgent(deps, authorization);
  const result: CreatePostResponse = createPost(deps, principal, roomId, body);
  const status = result.outcome === "accepted" ? HTTP_STATUS.created : HTTP_STATUS.ok;
  return json(result, status);
}

function handleRevoke(
  deps: RoomDeps,
  roomId: string,
  agentId: string,
  authorization: string | undefined,
): Response {
  if (!isId(roomId) || !roomExists(deps, roomId)) {
    return json(RoomHttpError.notFound().body(), HTTP_STATUS.notFound);
  }
  const principal = requireBearer(deps, authorization);
  revokeAgentKey(deps, principal, roomId, agentId);
  return json({ revoked: true }, HTTP_STATUS.ok);
}

function requireAgent(deps: RoomDeps, authorization: string | undefined): Extract<AuthPrincipal, { kind: "agent" }> {
  const principal = requireBearer(deps, authorization);
  if (principal.kind !== "agent") throw RoomHttpError.unauthorized();
  return principal;
}

function requireBearer(deps: RoomDeps, authorization: string | undefined): AuthPrincipal {
  const token = readBearerToken(authorization);
  if (!token || isRevokedAgentKey(deps, token)) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

interface JoinAddress {
  method: "GET" | "POST" | "PUT";
  url: string;
}

/**
 * Absolute addresses for the room this join just opened.
 * `read` is the posts list. `feed` is the room feed. `sharing` has no `/api` prefix.
 * The origin is normalized before these URLs are compared, so the returned
 * addresses stay on one clean origin.
 */
function joinAddresses(origin: string, roomId: string): {
  post: JoinAddress;
  read: JoinAddress;
  feed: JoinAddress;
  sharing: JoinAddress;
} {
  if (!isId(roomId)) throw new Error("refusing to send an address");
  return {
    post: absoluteAddress("POST", origin, `/api/r/${roomId}`),
    read: absoluteAddress("GET", origin, `/api/r/${roomId}`),
    feed: absoluteAddress("GET", origin, `/rooms/${roomId}/feed`),
    sharing: absoluteAddress("PUT", origin, `/rooms/${roomId}/sharing`),
  };
}

function absoluteAddress(method: "GET" | "POST" | "PUT", origin: string, path: string): JoinAddress {
  const base = normalizeOrigin(origin);
  if (!base) throw new Error("refusing to send an address");
  let url: URL;
  try {
    url = new URL(path, `${base}/`);
  } catch {
    throw new Error("refusing to send an address");
  }
  if (url.origin !== base || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("refusing to send an address");
  }
  if (url.pathname !== path) throw new Error("refusing to send an address");
  return { method, url: url.toString() };
}

function recentPosts(deps: RoomDeps, principal: AuthPrincipal, roomId: string): { text: string }[] {
  return recentMessages(deps, principal, roomId);
}

function inviteIdForSecret(deps: RoomDeps, roomId: string, secret: string): string | null {
  ensureInviteSchema(deps.db);
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  const hash = hashToken(secret);
  const rows = deps.db
    .prepare("SELECT id, secret_hash FROM invites WHERE room_id = ? AND secret_hash = ?")
    .all(roomId, hash) as { id: string; secret_hash: string }[];
  const matches = rows.filter((row) => isInviteId(row.id) && sameHash(secret, row.secret_hash));
  if (matches.length !== 1) return null;
  return matches[0]?.id ?? null;
}

function roomExists(deps: RoomDeps, roomId: string): boolean {
  const row = deps.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId) as { id: string } | undefined;
  return row !== undefined;
}

function roomTitle(deps: RoomDeps, roomId: string): string {
  ensureInviteSchema(deps.db);
  const row = deps.db.prepare("SELECT title FROM room_titles WHERE room_id = ?").get(roomId) as
    | { title: string }
    | undefined;
  return row?.title ?? "Room";
}

function sameHash(presented: string, expectedHex: string): boolean {
  const got = Buffer.from(hashToken(presented));
  const expected = Buffer.from(expectedHex);
  if (got.length === 0 || got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function assertHidden(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && (text.includes(secret) || text.includes(hashToken(secret)))) {
      throw new Error("refusing to send a secret");
    }
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
