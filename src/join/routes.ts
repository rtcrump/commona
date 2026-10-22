import type { Context } from "hono";
import { hashToken, HTTP_STATUS, readBearerToken, type AuthPrincipal } from "../../contract/index.js";
import { renderError } from "../onboarding/html.js";
import type { AppEnv, CommonaHono } from "../http/types.js";
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
import { registerJoinPages, sendJoinResult, wantsJoinPage } from "./page-routes.js";
import { ensureInviteSchema } from "./schema.js";
import { createInvite, isInviteId, redeemInvite, revokeInvite, secretForCookie } from "./service.js";

function requirePrincipal(deps: RoomDeps, authorization: string | undefined): AuthPrincipal {
  const token = readBearerToken(authorization);
  if (!token) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

function requireAgent(deps: RoomDeps, authorization: string | undefined): { agentId: string; ownerId: string } {
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

function originOf(url: string, hostHeader: string | undefined): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const host = hostHeader ?? "localhost";
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "http://localhost";
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (name !== "localhost" && name !== "127.0.0.1") return `https://${host}`;
  const protocol = new URL(url).protocol === "https:" ? "https" : "http";
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

function privateJson(body: unknown, status: number, extra?: Record<string, string>): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function registerInviteRoutes(app: CommonaHono, deps: RoomDeps): void {
  ensureInviteSchema(deps.db);
  registerJoinPages(app, deps);

  app.post("/rooms/:room/invites", (c) => {
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    const created = createInvite(deps, principal, c.req.param("room"), c.get("parsedBody"));
    const body = {
      invite: {
        id: created.id,
        link: `${originOf(c.req.url, c.req.header("host"))}/j/${created.id}/${created.secret}`,
        expiresAt: created.expiresAt,
      },
    };
    return c.json(body, HTTP_STATUS.created);
  });

  app.delete("/rooms/:room/invites/:inviteId", (c) => {
    const principal = requirePrincipal(deps, c.req.header("authorization"));
    revokeInvite(deps, principal, c.req.param("room"), c.req.param("inviteId"));
    return c.json({ revoked: true }, HTTP_STATUS.ok);
  });

  app.get("/j/:id/:secret", (c) => openInvite(c, c.req.param("secret") ?? ""));
  app.get("/j/:id", (c) => openInvite(c, ""));

  function openInvite(c: Context<AppEnv>, presented: string): Response {
    const id = c.req.param("id") ?? "";
    if (isInviteId(id) && !inviteRow(deps, id)) return missingInvite(c.req.header("accept"));
    if (isInviteId(id)) inviteLog(`invite view id=${id}`);
    const secret = secretForCookie(deps, id, presented);
    if (wantsJoinPage(c.req.header("accept"))) {
      return sendJoinResult(openWelcome(deps, id, secret));
    }
    const body = { ok: true as const };
    if (secret) assertPublic(body, [secret, hashToken(secret)]);
    const headers = new Headers({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-type": "application/json",
    });
    if (secret && /^[A-Za-z0-9_-]+$/.test(secret)) {
      const maxAge = cookieMaxAge(deps, id);
      headers.append("set-cookie", serializeCookie(INVITE_COOKIE, secret, "/j", maxAge));
    }
    return new Response(JSON.stringify(body), { status: HTTP_STATUS.ok, headers });
  }

  app.post("/connect/handoff", (c) => {
    const parsed = readClaim(c.get("parsedBody"));
    if (!parsed || !handoffAllowsConnector(handoffDeps(deps), parsed.handoff, parsed.roomId)) {
      throw RoomHttpError.forbidden();
    }
    return privateJson({ ok: true }, HTTP_STATUS.ok, { "referrer-policy": "no-referrer" });
  });

  app.post("/connect/claim", (c) => {
    const parsed = readClaim(c.get("parsedBody"));
    if (!parsed) throw RoomHttpError.forbidden();
    try {
      const claimed = claimConnectLink(handoffDeps(deps), parsed.handoff, parsed.roomId);
      return privateJson(
        {
          agentId: claimed.agentId,
          ownerId: claimed.ownerId,
          roomId: claimed.roomId,
          credential: claimed.credential,
        },
        HTTP_STATUS.ok,
        { "referrer-policy": "no-referrer" },
      );
    } catch {
      throw RoomHttpError.forbidden();
    }
  });

  app.post("/connect/arrive", (c) => {
    const agent = requireAgent(deps, c.req.header("authorization"));
    try {
      noteArrival(handoffDeps(deps), agent.agentId, agent.ownerId);
    } catch {
      throw RoomHttpError.forbidden();
    }
    return privateJson({ ok: true }, HTTP_STATUS.ok);
  });

  app.get("/connect/pending", (c) => {
    const agent = requireAgent(deps, c.req.header("authorization"));
    const checkId = takePendingCheck(handoffDeps(deps), agent.agentId);
    return privateJson({ checkId }, HTTP_STATUS.ok);
  });

  app.post("/connect/check-in", (c) => {
    const agent = requireAgent(deps, c.req.header("authorization"));
    const checkId = readCheckId(c.get("parsedBody"));
    if (!checkId || !answerCheck(handoffDeps(deps), agent.agentId, checkId)) throw RoomHttpError.forbidden();
    return privateJson({ ok: true }, HTTP_STATUS.ok);
  });

  app.post("/j/:id/accept", (c) => {
    const secret = readCookie(c.req.header("cookie"), INVITE_COOKIE);
    const roomHint = readRoomHint(c.get("parsedBody"));
    const redeemed = redeemInvite(deps, c.req.param("id"), secret, roomHint);
    const body = {
      owner: redeemed.owner,
      agent: redeemed.agent,
      member: redeemed.member,
      sharing: redeemed.sharing,
    };
    const hidden = [redeemed.sessionToken, secret ?? ""].filter((value) => value.length > 0);
    assertPublic(body, [...hidden, ...hidden.map((value) => hashToken(value))]);
    if (!/^[A-Za-z0-9_-]+$/.test(redeemed.sessionToken)) throw new Error("refusing to send a secret");
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    headers.append("set-cookie", serializeCookie(SESSION_COOKIE, redeemed.sessionToken, "/"));
    return new Response(JSON.stringify(body), { status: HTTP_STATUS.created, headers });
  });
}

function inviteRow(deps: RoomDeps, id: string): boolean {
  ensureInviteSchema(deps.db);
  const row = deps.db.prepare("SELECT id FROM invites WHERE id = ?").get(id) as { id: string } | undefined;
  return row !== undefined;
}

function missingInvite(accept: string | undefined): Response {
  if (wantsJoinPage(accept)) {
    return new Response(renderError("This link can't be used, so ask the person who sent it for a new link."), {
      status: HTTP_STATUS.notFound,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  return new Response(JSON.stringify(RoomHttpError.notFound().body()), {
    status: HTTP_STATUS.notFound,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function cookieMaxAge(deps: RoomDeps, id: string): number {
  const row = deps.db.prepare("SELECT expires_at FROM invites WHERE id = ?").get(id) as { expires_at: string } | undefined;
  if (!row) return 60;
  const seconds = Math.floor((Date.parse(row.expires_at) - deps.clock.now().getTime()) / 1000);
  return Math.max(1, seconds);
}
