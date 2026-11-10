import { timingSafeEqual } from "node:crypto";
import { formatTimestamp, hashToken, isId, type AuthPrincipal } from "../../contract/index.js";
import { isRevokedAgentKey } from "../agent-api/keys.js";
import { AgentPostLimited } from "../agent-api/limit.js";
import type { CommonaHono } from "../http/types.js";
import { readCookie, serializeCookie } from "../join/cookies.js";
import { ensureInviteSchema } from "../join/schema.js";
import { isInviteId, redeemInvite } from "../join/service.js";
import { newSecret } from "../onboarding/account.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { readBrief } from "../room/brief.js";
import { createPost } from "../room/posts.js";
import { RoomClosed, roomTalkStatus } from "../room/proposals.js";
import { recentMessages } from "./messages.js";
import { renderRoomMessage, renderRoomPage } from "./page.js";
import { ensureRoomPageSchema } from "./schema.js";

/** Per-room agent cookie. Two rooms do not share one name or one path. */
export function agentCookieName(roomId: string): string {
  return `commona_agent_${roomId}`;
}

/** Per-room sharing-key cookie. It carries the raw key only until the next page read. */
export function sharingCookieName(roomId: string): string {
  return `commona_share_${roomId}`;
}

function agentCookiePath(roomId: string): string {
  return `/r/${roomId}`;
}

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
    if (secret) return openInvite(deps, input.roomId, input.inviteId, secret, input.cookie);
    return showForCookie(deps, input.roomId, input.cookie);
  } catch (error) {
    return htmlFromError(error);
  }
}

function openInvite(
  deps: RoomDeps,
  roomId: string,
  inviteId: string | null,
  secret: string,
  cookie: string | undefined,
): Response {
  const gate = classifyInvite(deps, roomId, inviteId, secret);
  if (gate === "open") return redeemAndRedirect(deps, roomId, inviteId, secret);
  if (agentFromCookie(deps, roomId, cookie) === "revoked") {
    return htmlResponse(renderRoomMessage("This key was revoked."), 401);
  }
  if (gate === "used" && memberFromCookie(deps, roomId, cookie)) {
    return showForCookie(deps, roomId, cookie, [secret]);
  }
  return htmlResponse(renderRoomMessage("This invite cannot be used. Ask for a new link."), 403);
}

function redeemAndRedirect(deps: RoomDeps, roomId: string, inviteId: string | null, secret: string): Response {
  const id = inviteId ?? inviteIdForSecret(deps, roomId, secret);
  if (!id) return htmlResponse(renderRoomMessage("This invite cannot be used. Ask for a new link."), 403);
  let redeemed;
  try {
    redeemed = redeemInvite(deps, id, secret, roomId, { defaultRoomPosts: true });
  } catch (error) {
    if (error instanceof RoomHttpError) {
      return htmlResponse(renderRoomMessage("This invite cannot be used. Ask for a new link."), error.status);
    }
    throw error;
  }
  const key = deps.tokens.issueAgentToken(redeemed.agent.id);
  const sharingKey = deps.tokens.issueNarrowToken(redeemed.owner.id);
  const sessionToken = redeemed.sessionToken;
  if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9_-]+$/.test(sharingKey)) {
    throw new Error("refusing to send a secret");
  }
  saveKeyFlash(deps, redeemed.agent.id, roomId, key);
  saveSharingFlash(deps, redeemed.agent.id, roomId, sharingKey);
  const location = `/r/${roomId}`;
  assertHidden(location, [secret, key, sharingKey, sessionToken]);
  const cookies = [
    serializeCookie(agentCookieName(roomId), key, agentCookiePath(roomId)),
    serializeCookie(sharingCookieName(roomId), sharingKey, agentCookiePath(roomId)),
  ];
  assertHidden(cookies.join("\n"), [secret, sessionToken, hashToken(sessionToken)]);
  return redirect(location, cookies);
}

function showForCookie(
  deps: RoomDeps,
  roomId: string,
  cookie: string | undefined,
  hidden: readonly string[] = [],
): Response {
  const principal = agentFromCookie(deps, roomId, cookie);
  if (principal === "revoked") return htmlResponse(renderRoomMessage("This key was revoked."), 401);
  if (!principal) return htmlResponse(renderRoomMessage("Open an invite link to join this room."), 403);
  const posts = recentMessages(deps, principal, roomId);
  const nonce = newSecret();
  saveFormToken(deps, principal.agentId, roomId, nonce);
  const agentKey = takeKeyFlash(deps, principal.agentId, roomId);
  const presentedKey = readCookie(cookie, sharingCookieName(roomId));
  const sharingKey = takeSharingFlash(deps, principal.agentId, roomId, presentedKey);
  const page = renderRoomPage({
    title: roomTitle(deps, roomId),
    roomId,
    brief: readBrief(deps, roomId),
    posts,
    nonce,
    ownerId: principal.ownerId,
    agentKey,
    sharingKey,
    agentId: agentKey === null ? null : principal.agentId,
    roomStatus: roomTalkStatus(deps, roomId, principal.ownerId),
  });
  assertHidden(page, hidden);
  const cookies =
    presentedKey === null
      ? []
      : [serializeCookie(sharingCookieName(roomId), "", agentCookiePath(roomId), 0)];
  return htmlResponse(page, 200, cookies);
}

function handlePost(deps: RoomDeps, roomId: string, cookie: string | undefined, body: unknown): Response {
  try {
    if (!isId(roomId) || !roomExists(deps, roomId)) {
      return htmlResponse(renderRoomMessage("This room is not here."), 404);
    }
    const principal = agentFromCookie(deps, roomId, cookie);
    if (principal === "revoked") return htmlResponse(renderRoomMessage("This key was revoked."), 401);
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
      if (error instanceof RoomClosed) {
        return htmlResponse(renderRoomMessage(error.message), error.status);
      }
      if (error instanceof RoomHttpError) {
        return htmlResponse(renderRoomMessage("The message was not posted."), error.status);
      }
      throw error;
    }
    if (result.outcome === "held") {
      return htmlResponse(renderRoomMessage("That message was held and is not shown."), 200);
    }
    const location = `/r/${roomId}`;
    assertHidden(location, [nonce, readCookie(cookie, agentCookieName(roomId)) ?? ""]);
    return redirect(location, []);
  } catch (error) {
    return htmlFromError(error);
  }
}

function memberFromCookie(deps: RoomDeps, roomId: string, cookie: string | undefined): boolean {
  const principal = agentFromCookie(deps, roomId, cookie);
  if (!principal || principal === "revoked") return false;
  const row = deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND agent_id = ?")
    .get(roomId, principal.agentId) as { ok: number } | undefined;
  return row !== undefined;
}

type InviteGate = "open" | "used" | "closed";

function classifyInvite(deps: RoomDeps, roomId: string, inviteId: string | null, secret: string): InviteGate {
  ensureInviteSchema(deps.db);
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return "closed";
  const id = inviteId && isInviteId(inviteId) ? inviteId : inviteIdForSecret(deps, roomId, secret);
  if (!id) return "closed";
  const row = deps.db
    .prepare("SELECT room_id, secret_hash, used_at, revoked_at, expires_at FROM invites WHERE id = ?")
    .get(id) as
    | { room_id: string; secret_hash: string; used_at: string | null; revoked_at: string | null; expires_at: string }
    | undefined;
  if (!row || row.room_id !== roomId || !sameHash(secret, row.secret_hash)) return "closed";
  if (row.revoked_at !== null || row.expires_at <= formatTimestamp(deps.clock.now())) return "closed";
  if (row.used_at !== null) return "used";
  return "open";
}

function saveKeyFlash(deps: RoomDeps, agentId: string, roomId: string, key: string): void {
  ensureRoomPageSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO room_key_flash (agent_id, room_id, agent_key) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET room_id = excluded.room_id, agent_key = excluded.agent_key`,
    )
    .run(agentId, roomId, key);
}

function takeKeyFlash(deps: RoomDeps, agentId: string, roomId: string): string | null {
  ensureRoomPageSchema(deps.db);
  const row = deps.db
    .prepare("SELECT agent_key FROM room_key_flash WHERE agent_id = ? AND room_id = ?")
    .get(agentId, roomId) as { agent_key: string } | undefined;
  if (!row) return null;
  deps.db.prepare("DELETE FROM room_key_flash WHERE agent_id = ? AND room_id = ?").run(agentId, roomId);
  return row.agent_key;
}

function saveSharingFlash(deps: RoomDeps, agentId: string, roomId: string, token: string): void {
  ensureRoomPageSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO room_sharing_flash (agent_id, room_id, token_hash) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET room_id = excluded.room_id, token_hash = excluded.token_hash`,
    )
    .run(agentId, roomId, hashToken(token));
}

function takeSharingFlash(deps: RoomDeps, agentId: string, roomId: string, presented: string | null): string | null {
  ensureRoomPageSchema(deps.db);
  if (!presented || !/^[A-Za-z0-9_-]+$/.test(presented)) return null;
  const row = deps.db
    .prepare("SELECT token_hash FROM room_sharing_flash WHERE agent_id = ? AND room_id = ?")
    .get(agentId, roomId) as { token_hash: string } | undefined;
  if (!row || !sameHash(presented, row.token_hash)) return null;
  deps.db.prepare("DELETE FROM room_sharing_flash WHERE agent_id = ? AND room_id = ?").run(agentId, roomId);
  return presented;
}

function agentFromCookie(
  deps: RoomDeps,
  roomId: string,
  cookie: string | undefined,
): Extract<AuthPrincipal, { kind: "agent" }> | "revoked" | null {
  const key = readCookie(cookie, agentCookieName(roomId));
  if (!key) return null;
  if (isRevokedAgentKey(deps, key)) return "revoked";
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
  if (error instanceof RoomClosed) {
    return htmlResponse(renderRoomMessage(error.message), error.status);
  }
  if (error instanceof AgentPostLimited) {
    return htmlResponse(renderRoomMessage("Try again later."), 429, [], error.retryAfter);
  }
  if (error instanceof RoomHttpError) {
    const sentence = error.status === 404 ? "This room is not here." : "This invite cannot be used. Ask for a new link.";
    return htmlResponse(renderRoomMessage(sentence), error.status);
  }
  throw error;
}

function htmlResponse(
  body: string,
  status: number,
  cookies: readonly string[] = [],
  retryAfter?: number,
): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'",
  });
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
