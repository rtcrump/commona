import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashToken, HTTP_STATUS, readBearerToken, type AuthPrincipal } from "../../contract/index.js";
import {
  answerCheck,
  claimConnectLink,
  handoffAllowsConnector,
  noteArrival,
  takePendingCheck,
} from "../onboarding/connect.js";
import { openWelcome } from "../onboarding/join-flow.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { INVITE_COOKIE, readCookie, serializeCookie, SESSION_COOKIE } from "./cookies.js";
import { inviteLog } from "./log.js";
import { registerFormParser, registerJoinPages, sendJoinResult, wantsJoinPage } from "./page-routes.js";
import { ensureInviteSchema } from "./schema.js";
import { createInvite, isInviteId, redeemInvite, revokeInvite, secretForCookie } from "./service.js";

function requirePrincipal(deps: RoomDeps, authorization: string | string[] | undefined): AuthPrincipal {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = readBearerToken(header);
  if (!token) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

function requireAgent(deps: RoomDeps, authorization: string | string[] | undefined): { agentId: string; ownerId: string } {
  const principal = requirePrincipal(deps, authorization);
  if (principal.kind !== "agent") throw RoomHttpError.unauthorized();
  return { agentId: principal.agentId, ownerId: principal.ownerId };
}

function handoffDeps(deps: RoomDeps) {
  return { db: deps.db, clock: deps.clock, tokens: deps.tokens };
}

function readClaim(body: unknown): { handoff: string; roomId: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const handoff = (body as { handoff?: unknown }).handoff;
  const roomId = (body as { roomId?: unknown }).roomId;
  if (typeof handoff !== "string" || typeof roomId !== "string") return null;
  if (handoff.length === 0 || roomId.length === 0) return null;
  return { handoff, roomId };
}

function readCheckId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const checkId = (body as { checkId?: unknown }).checkId;
  if (typeof checkId !== "string" || checkId.length === 0) return null;
  return checkId;
}

function originOf(request: FastifyRequest): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const host = request.headers.host ?? "localhost";
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "http://localhost";
  const name = host.replace(/:\d+$/, "").toLowerCase();
  // A non-local http link cannot store the Secure invite cookie.
  if (name !== "localhost" && name !== "127.0.0.1") return `https://${host}`;
  const protocol = request.protocol === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}

function configuredPublicOrigin(): string | undefined {
  const raw = process.env.COMMONA_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(raw)) return raw;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(raw)) return raw;
  throw new Error("COMMONA_PUBLIC_ORIGIN must be an https origin");
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
  registerFormParser(app);
  registerJoinPages(app, deps);

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
    if (wantsJoinPage(request.headers.accept)) {
      return sendJoinResult(reply, openWelcome(deps, id, secret));
    }
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

  app.post("/connect/handoff", async (request, reply) => {
    const parsed = readClaim(request.body);
    if (!parsed || !handoffAllowsConnector(handoffDeps(deps), parsed.handoff, parsed.roomId)) {
      throw RoomHttpError.forbidden();
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return reply.code(HTTP_STATUS.ok).send({ ok: true });
  });

  app.post("/connect/claim", async (request, reply) => {
    const parsed = readClaim(request.body);
    if (!parsed) throw RoomHttpError.forbidden();
    try {
      const claimed = claimConnectLink(handoffDeps(deps), parsed.handoff, parsed.roomId);
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      return reply.code(HTTP_STATUS.ok).send({
        agentId: claimed.agentId,
        ownerId: claimed.ownerId,
        roomId: claimed.roomId,
        credential: claimed.credential,
      });
    } catch {
      throw RoomHttpError.forbidden();
    }
  });

  app.post("/connect/arrive", async (request, reply) => {
    const agent = requireAgent(deps, request.headers.authorization);
    try {
      noteArrival(handoffDeps(deps), agent.agentId, agent.ownerId);
    } catch {
      throw RoomHttpError.forbidden();
    }
    reply.header("Cache-Control", "no-store");
    return reply.code(HTTP_STATUS.ok).send({ ok: true });
  });

  app.get("/connect/pending", async (request, reply) => {
    const agent = requireAgent(deps, request.headers.authorization);
    const checkId = takePendingCheck(handoffDeps(deps), agent.agentId);
    reply.header("Cache-Control", "no-store");
    return reply.code(HTTP_STATUS.ok).send({ checkId });
  });

  app.post("/connect/check-in", async (request, reply) => {
    const agent = requireAgent(deps, request.headers.authorization);
    const checkId = readCheckId(request.body);
    if (!checkId || !answerCheck(handoffDeps(deps), agent.agentId, checkId)) throw RoomHttpError.forbidden();
    reply.header("Cache-Control", "no-store");
    return reply.code(HTTP_STATUS.ok).send({ ok: true });
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
