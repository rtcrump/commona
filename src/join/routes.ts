import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashToken, HTTP_STATUS, readBearerToken, type AuthPrincipal } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { inviteLog } from "./log.js";
import { ensureInviteSchema } from "./schema.js";
import { createInvite, isInviteId, redeemInvite, revokeInvite, secretForCookie } from "./service.js";

const INVITE_COOKIE = "commona_invite";
const SESSION_COOKIE = "commona_session";

function requirePrincipal(deps: RoomDeps, authorization: string | string[] | undefined): AuthPrincipal {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = readBearerToken(header);
  if (!token) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

function originOf(request: FastifyRequest): string {
  const host = request.headers.host ?? "localhost";
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "http://localhost";
  const protocol = request.protocol === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}

function serializeCookie(name: string, value: string, path: string, maxAge?: number): string {
  const age = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}${age}`;
}

function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function readRoomHint(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) return "";
  const roomId = (body as { roomId?: unknown }).roomId;
  if (roomId === undefined) return undefined;
  if (typeof roomId !== "string") return "";
  return roomId;
}

function assertPublic(body: unknown, forbidden: readonly string[]): void {
  const text = JSON.stringify(body);
  for (const secret of forbidden) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error("refusing to send a secret");
    }
  }
}

export function registerInviteRoutes(app: FastifyInstance, deps: RoomDeps): void {
  ensureInviteSchema(deps.db);

  app.post<{ Params: { room: string } }>("/rooms/:room/invites", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const created = createInvite(deps, principal, request.params.room, request.body);
    const body = {
      invite: {
        id: created.id,
        link: `${originOf(request)}/j/${created.id}`,
        expiresAt: created.expiresAt,
      },
    };
    return reply.code(HTTP_STATUS.created).send(body);
  });

  app.delete<{ Params: { room: string; inviteId: string } }>(
    "/rooms/:room/invites/:inviteId",
    async (request, reply) => {
      const principal = requirePrincipal(deps, request.headers.authorization);
      revokeInvite(deps, principal, request.params.room, request.params.inviteId);
      const body = { revoked: true };
      return reply.code(HTTP_STATUS.ok).send(body);
    },
  );

  app.get<{ Params: { id: string } }>("/j/:id", async (request, reply) => {
    const id = request.params.id;
    if (isInviteId(id)) inviteLog(`invite view id=${id}`);
    const secret = secretForCookie(deps, id);
    const body = { ok: true as const };
    if (secret) assertPublic(body, [secret, hashToken(secret)]);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    if (secret && /^[A-Za-z0-9_-]+$/.test(secret)) {
      const maxAge = cookieMaxAge(deps, id);
      reply.header("Set-Cookie", serializeCookie(INVITE_COOKIE, secret, "/j", maxAge));
    }
    return reply.code(HTTP_STATUS.ok).send(body);
  });

  app.post<{ Params: { id: string } }>("/j/:id/accept", async (request, reply) => {
    const secret = readCookie(request.headers.cookie, INVITE_COOKIE);
    const roomHint = readRoomHint(request.body);
    const redeemed = redeemInvite(deps, request.params.id, secret, roomHint);
    const body = {
      owner: redeemed.owner,
      agent: redeemed.agent,
      member: redeemed.member,
      sharing: redeemed.sharing,
    };
    const hidden = [redeemed.sessionToken, secret ?? ""].filter((value) => value.length > 0);
    assertPublic(body, [...hidden, ...hidden.map((value) => hashToken(value))]);
    if (!/^[A-Za-z0-9_-]+$/.test(redeemed.sessionToken)) throw new Error("refusing to send a secret");
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", serializeCookie(SESSION_COOKIE, redeemed.sessionToken, "/"));
    return reply.code(HTTP_STATUS.created).send(body);
  });
}

function cookieMaxAge(deps: RoomDeps, id: string): number {
  const row = deps.db.prepare("SELECT expires_at FROM invites WHERE id = ?").get(id) as
    | { expires_at: string }
    | undefined;
  if (!row) return 60;
  const seconds = Math.floor((Date.parse(row.expires_at) - deps.clock.now().getTime()) / 1000);
  return Math.max(1, seconds);
}
