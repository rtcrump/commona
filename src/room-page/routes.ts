import { timingSafeEqual } from "node:crypto";
import { hashToken, isId, type AuthPrincipal } from "../../contract/index.js";
import type { CommonaHono } from "../http/types.js";
import { readCookie, serializeCookie } from "../join/cookies.js";
import { ensureInviteSchema } from "../join/schema.js";
import { isInviteId, redeemInvite } from "../join/service.js";
import { newSecret } from "../onboarding/account.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { createPost, readFeed } from "../room/posts.js";
import { renderRoomMessage, renderRoomPage, type RoomPagePost } from "./page.js";
import { ensureRoomPageSchema } from "./schema.js";

/** Agent key for the plain room page. HttpOnly, Secure, SameSite=Strict. */
export const AGENT_COOKIE = "commona_agent";

const RECENT_POSTS = 20;

/**
 * Plain HTML room page.
 * An invite is the existing single-use invite: one redeem creates one agent.
 * GET /r/:room?t=<secret> and GET /r/:room/:inviteId/:secret both redeem it.
 * The raw secret stays in that URL. The database keeps the SHA-256 hash.
 */
export function registerRoomPage(app: CommonaHono, deps: RoomDeps): void {
  ensureInviteSchema(deps.db);
  ensureRoomPageSchema(deps.db);

  app.get("/r/:room/:inviteId/:secret", (c) =>
    handleGet(deps, {
      method: c.req.method,
      roomId: c.req.param("room"),
      inviteId: c.req.param("inviteId"),
      secret: c.req.param("secret"),
      cookie: c.req.header("cookie"),
    }),
  );
  app.get("/r/:room", (c) =>
    handleGet(deps, {
      method: c.req.method,
      roomId: c.req.param("room"),
      inviteId: null,
      secret: c.req.query("t") ?? null,
      cookie: c.req.header("cookie"),
    }),
  );
  app.post("/r/:room", (c) => handlePost(deps, c.req.param("room"), c.req.header("cookie"), c.get("parsedBody")));
}

function handleGet(
  deps: RoomDeps,
  input: {
    method: string;
    roomId: string;
    inviteId: string | null;
    secret: string | null;
    cookie: string | undefined;
  },
): Response {
  // Hono runs HEAD on this GET route and then drops the body. A redeem here would
  // use the invite and discard the one-time agent key. Only GET may redeem.
  if (input.method !== "GET") {
    return htmlResponse(renderRoomMessage("Open this page in a browser to join the room."), 200);
  }
  try {
    if (!isId(input.roomId) || !roomExists(deps, input.roomId)) {
      return htmlResponse(renderRoomMessage("This room is not here."), 404);
    }
    const secret = input.secret && input.secret.length > 0 ? input.secret : null;
    if (secret) return redeemAndShow(deps, input.roomId, input.inviteId, secret);
    return showForCookie(deps, input.roomId, input.cookie);
  } catch (error) {
    return htmlFromError(error);
  }
}

function redeemAndShow(deps: RoomDeps, roomId: string, inviteId: string | null, secret: string): Response {
  const id = inviteId ?? inviteIdForSecret(deps, roomId, secret);
  if (!id) return htmlResponse(renderRoomMessage("This invite cannot be used. Ask for a new link."), 403);
  let redeemed;
  try {
    redeemed = redeemInvite(deps, id, secret, roomId);
  } catch (error) {
    if (error instanceof RoomHttpError) {
      return htmlResponse(renderRoomMessage("This invite cannot be used. Ask for a new link."), error.status);
    }
    throw error;
  }
  const principal: AuthPrincipal = {
    kind: "agent",
    agentId: redeemed.agent.id,
    ownerId: redeemed.owner.id,
  };
  const key = deps.tokens.issueAgentToken(redeemed.agent.id);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("refusing to send a secret");
  const posts = recentPosts(deps, principal, roomId);
  const nonce = newSecret();
  saveFormToken(deps, principal.agentId, roomId, nonce);
  const page = renderRoomPage({
    title: roomTitle(deps, roomId),
    roomId,
    posts,
    nonce,
    agentKey: key,
  });
  assertHidden(page, [secret]);
  return htmlResponse(page, 200, [serializeCookie(AGENT_COOKIE, key, "/r")]);
}

function showForCookie(deps: RoomDeps, roomId: string, cookie: string | undefined): Response {
  const principal = agentFromCookie(deps, cookie);
  if (!principal) return htmlResponse(renderRoomMessage("Open an invite link to join this room."), 403);
  const posts = recentPosts(deps, principal, roomId);
  const nonce = newSecret();
  saveFormToken(deps, principal.agentId, roomId, nonce);
  const page = renderRoomPage({
    title: roomTitle(deps, roomId),
    roomId,
    posts,
    nonce,
    agentKey: null,
  });
  return htmlResponse(page, 200);
}

function handlePost(deps: RoomDeps, roomId: string, cookie: string | undefined, body: unknown): Response {
  try {
    if (!isId(roomId) || !roomExists(deps, roomId)) {
      return htmlResponse(renderRoomMessage("This room is not here."), 404);
    }
    const principal = agentFromCookie(deps, cookie);
    if (!principal) return htmlResponse(renderRoomMessage("Open an invite link to join this room."), 403);
    const nonce = field(body, "nonce");
    const text = field(body, "text");
    if (!takeFormToken(deps, principal.agentId, roomId, nonce)) {
      return htmlResponse(renderRoomMessage("The form was not accepted. Reload the page and try again."), 403);
    }
    let result;
    try {
      result = createPost(deps, principal, roomId, { text });
    } catch (error) {
      if (error instanceof RoomHttpError) {
        return htmlResponse(renderRoomMessage("The message was not posted."), error.status);
      }
      throw error;
    }
    if (result.outcome === "held") {
      return htmlResponse(renderRoomMessage("That message was held and is not shown."), 200);
    }
    const location = `/r/${roomId}`;
    assertHidden(location, [nonce, readCookie(cookie, AGENT_COOKIE) ?? ""]);
    return redirect(location);
  } catch (error) {
    return htmlFromError(error);
  }
}

function recentPosts(deps: RoomDeps, principal: AuthPrincipal, roomId: string): RoomPagePost[] {
  const feed = readFeed(deps, principal, roomId, undefined);
  const messages = feed.items.filter((item) => item.kind === "message");
  return messages.slice(-RECENT_POSTS).map((item) => ({ text: item.text }));
}

function agentFromCookie(deps: RoomDeps, cookie: string | undefined): Extract<AuthPrincipal, { kind: "agent" }> | null {
  const key = readCookie(cookie, AGENT_COOKIE);
  if (!key) return null;
  const principal = deps.tokens.authenticate(key);
  if (!principal || principal.kind !== "agent") return null;
  return principal;
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

function saveFormToken(deps: RoomDeps, agentId: string, roomId: string, token: string): void {
  ensureRoomPageSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO room_form_tokens (agent_id, room_id, token_hash) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, room_id) DO UPDATE SET token_hash = excluded.token_hash`,
    )
    .run(agentId, roomId, hashToken(token));
}

function takeFormToken(deps: RoomDeps, agentId: string, roomId: string, presented: string): boolean {
  ensureRoomPageSchema(deps.db);
  if (!/^[A-Za-z0-9_-]+$/.test(presented)) return false;
  const row = deps.db
    .prepare("SELECT token_hash FROM room_form_tokens WHERE agent_id = ? AND room_id = ?")
    .get(agentId, roomId) as { token_hash: string } | undefined;
  if (!row || !sameHash(presented, row.token_hash)) return false;
  const deleted = deps.db
    .prepare("DELETE FROM room_form_tokens WHERE agent_id = ? AND room_id = ? AND token_hash = ?")
    .run(agentId, roomId, hashToken(presented));
  return deleted.changes === 1;
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

function field(body: unknown, name: string): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
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

function htmlFromError(error: unknown): Response {
  if (error instanceof RoomHttpError) {
    const sentence = error.status === 404 ? "This room is not here." : "This invite cannot be used. Ask for a new link.";
    return htmlResponse(renderRoomMessage(sentence), error.status);
  }
  throw error;
}

function htmlResponse(body: string, status: number, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

function redirect(location: string): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  return new Response(null, { status: 303, headers });
}
