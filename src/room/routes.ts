import { HTTP_STATUS, isId, readBearerToken, type AuthPrincipal } from "../../contract/index.js";
import type { CommonaHono } from "../http/types.js";
import { readCookie, SESSION_COOKIE } from "../join/cookies.js";
import { deleteOwnedRoom } from "./delete-room.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";
import { addMember, createRoom, listRoomMembers } from "./membership.js";
import { createPost, readFeed, readFile, readHeld, uploadFile } from "./posts.js";
import { updateSharing } from "./sharing.js";

export function registerRoomRoutes(app: CommonaHono, deps: RoomDeps): void {
  app.post("/rooms", (c) => {
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const room = createRoom(deps, principal);
    return c.json({ room }, HTTP_STATUS.created);
  });

  app.delete("/rooms/:roomId", async (c) => {
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const result = await deleteOwnedRoom(deps, principal, c.req.param("roomId"));
    return c.json(result, HTTP_STATUS.ok, { "cache-control": "no-store" });
  });

  app.post("/rooms/:roomId/members", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const agentId = readAgentId(c.get("parsedBody"));
    const result = addMember(deps, principal, c.req.param("roomId"), agentId);
    const status = result.created ? HTTP_STATUS.created : HTTP_STATUS.ok;
    return c.json(result.response, status);
  });

  app.get("/rooms/:roomId/members", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    return c.json(listRoomMembers(deps, principal, c.req.param("roomId")), HTTP_STATUS.ok);
  });

  app.post("/rooms/:roomId/posts", async (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const result = await createPost(deps, principal, c.req.param("roomId"), c.get("parsedBody"));
    const status = result.outcome === "accepted" ? HTTP_STATUS.created : HTTP_STATUS.ok;
    return c.json(result, status);
  });

  app.post("/rooms/:roomId/files", async (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const result = await uploadFile(deps, principal, c.req.param("roomId"), c.get("parsedBody"));
    const status = result.outcome === "accepted" ? HTTP_STATUS.created : HTTP_STATUS.ok;
    return c.json(result, status);
  });

  app.get("/rooms/:roomId/feed", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const feed = readFeed(deps, principal, c.req.param("roomId"), c.req.query("as"));
    return c.json(feed, HTTP_STATUS.ok);
  });

  app.get("/rooms/:roomId/files/:fileId", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const file = readFile(deps, principal, c.req.param("roomId"), c.req.param("fileId"));
    return c.json(file, HTTP_STATUS.ok);
  });

  app.put("/rooms/:roomId/sharing", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = sharingPrincipal(deps, c.req.header("authorization"), c.req.header("cookie"));
    const sharing = updateSharing(deps, principal, c.req.param("roomId"), c.get("parsedBody"));
    return c.json(sharing, HTTP_STATUS.ok);
  });

  app.get("/rooms/:roomId/held", (c) => {
    absentRoom(deps, c.req.param("roomId"));
    const principal = heldPrincipal(deps, c.req.header("authorization"), c.req.header("cookie"));
    const held = readHeld(deps, principal, c.req.param("roomId"));
    return c.json(held, HTTP_STATUS.ok);
  });
}

/** A room id that is not stored is 404 before auth, so a deleted room does not look like a bad key. */
function absentRoom(deps: RoomDeps, roomId: string): void {
  if (!isId(roomId)) return;
  const room = deps.db.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId) as { id: string } | undefined;
  if (!room) throw RoomHttpError.notFound();
}

function requirePrincipal(deps: RoomDeps, authorization: string | undefined): AuthPrincipal {
  const token = readBearerToken(authorization);
  if (!token) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

/**
 * Bearer token when one is sent. Otherwise the human join session cookie, and only
 * when that cookie is an owner token. A bearer is never upgraded by the cookie.
 */
function sharingPrincipal(deps: RoomDeps, authorization: string | undefined, cookie: string | undefined): AuthPrincipal {
  const bearer = readBearerToken(authorization);
  if (bearer) return requirePrincipal(deps, authorization);
  const session = readCookie(cookie, SESSION_COOKIE);
  if (!session) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(session);
  if (!principal || principal.kind !== "owner") throw RoomHttpError.unauthorized();
  return principal;
}

/**
 * Bearer token when one is sent. Otherwise the browser session cookie.
 * A known owner from either one is refused by readHeld. A missing or unknown value is 401.
 */
function heldPrincipal(deps: RoomDeps, authorization: string | undefined, cookie: string | undefined): AuthPrincipal {
  const bearer = readBearerToken(authorization);
  if (bearer) {
    const principal = deps.tokens.authenticate(bearer);
    if (!principal) throw RoomHttpError.unauthorized();
    return principal;
  }
  const session = readCookie(cookie, SESSION_COOKIE);
  if (!session) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(session);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

function readAgentId(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw RoomHttpError.badRequest();
  const agentId = (body as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string") throw RoomHttpError.badRequest();
  return agentId;
}
