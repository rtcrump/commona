import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { guard } from "../guard/index.js";
import { dropInviteSecret } from "../join/pending.js";
import { ensureInviteSchema } from "../join/schema.js";
import { createInvite } from "../join/service.js";
import { openAccount } from "../onboarding/account.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";
import { addMember, createRoom } from "./membership.js";

const LABEL_MAX = 80;
const MAX_INVITE_COUNT = 20;
const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const FORWARDED_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip"];

/** Sent by room:new. Never written to a log. */
export const HOST_SECRET_HEADER = "x-commona-host-secret";

export const DEFAULT_HOST_PORT = 3002;

class HostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostInputError";
  }
}

/** True only for a loopback socket. Forwarded headers are not consulted. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Secret file for the host command. Override with COMMONA_HOST_SECRET_FILE. */
export function hostSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.COMMONA_HOST_SECRET_FILE?.trim();
  if (set) return set;
  return path.join(homedir(), ".commona", "host-secret");
}

export interface HostListener {
  url: string;
  secretPath: string;
  close: () => Promise<void>;
}

/**
 * A second listener, bound only to 127.0.0.1, for `npm run room:new`.
 * The public server does not serve this route. A tunnel that connects to the
 * main port never reaches this one. The host secret is written to a file and
 * is not logged.
 */
export async function startHostListener(
  deps: RoomDeps,
  options: { port?: number; secretPath?: string } = {},
): Promise<HostListener> {
  const port = resolvePort(options.port);
  const secretPath = options.secretPath ?? hostSecretPath();
  const secret = randomBytes(32).toString("base64url");
  writeHostSecret(secretPath, secret);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomHttpError) return reply.status(error.status).send(error.body());
    if (error instanceof HostInputError) return reply.status(400).send({ error: { message: error.message } });
    return reply.status(500).send({ error: { message: "room:new failed" } });
  });
  app.post("/host/room", async (request, reply) => {
    if (hasForwardedHeader(request) || !isLoopbackAddress(request.socket.remoteAddress)) {
      throw RoomHttpError.forbidden();
    }
    if (!secretsEqual(headerSecret(request), secret)) throw RoomHttpError.forbidden();
    const body = readBody(request.body);
    const origin = requireHttpsOrigin(process.env.COMMONA_PUBLIC_ORIGIN);
    const created = createHostRoom(deps, body, origin, secret);
    return reply.code(201).send(created);
  });
  try {
    await app.listen({ host: "127.0.0.1", port });
  } catch {
    await app.close();
    throw new Error("host command could not listen");
  }
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("host command could not listen");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    secretPath,
    close: () => app.close(),
  };
}

function resolvePort(override: number | undefined): number {
  if (override !== undefined) return override;
  const raw = process.env.COMMONA_HOST_PORT?.trim();
  if (!raw) return DEFAULT_HOST_PORT;
  if (!/^\d+$/.test(raw)) throw new Error("COMMONA_HOST_PORT is not a port");
  const port = Number(raw);
  if (port > 65535) throw new Error("COMMONA_HOST_PORT is not a port");
  return port;
}

function writeHostSecret(file: string, secret: string): void {
  // 0o600 is owner-only on Unix. Windows does not apply that mode.
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
  if (process.platform === "win32") return;
  chmodSync(file, 0o600);
}

function hasForwardedHeader(request: FastifyRequest): boolean {
  return FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined);
}

function headerSecret(request: FastifyRequest): string {
  const value = request.headers[HOST_SECRET_HEADER];
  return typeof value === "string" ? value : "";
}

function secretsEqual(got: string, expected: string): boolean {
  const right = Buffer.from(expected);
  const left = Buffer.from(got);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

interface HostRoomBody {
  title: string;
  hostName: string;
  inviteCount: number;
}

interface HostRoomResult {
  invites: string[];
  credential: string;
}

function createHostRoom(deps: RoomDeps, body: HostRoomBody, origin: string, hostSecret: string): HostRoomResult {
  const inviteIds: string[] = [];
  try {
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
        inviteIds.push(created.id);
        invites.push(`${origin}/j/${created.id}`);
      }
      const credential = deps.tokens.issueAgentToken(opened.agentId);
      assertClean(deps, invites, credential, [credential, opened.sessionToken, hostSecret]);
      return { invites, credential };
    });
    return write();
  } catch (error) {
    for (const id of inviteIds) dropInviteSecret(id);
    throw error;
  }
}

function assertClean(
  deps: RoomDeps,
  invites: readonly string[],
  credential: string,
  hidden: readonly string[],
): void {
  const details = deps.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  const auditText = details.map((row) => row.detail_json).join("\n");
  for (const secret of hidden) {
    if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) throw new HostInputError("room:new failed");
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
    title: requireLabel(title, "room title must be a short label", "room title is not allowed"),
    hostName: requireLabel(hostName, "host display name must be a short label", "host display name is not allowed"),
    inviteCount: requireCount(inviteCount),
  };
}

function requireLabel(raw: string, shapeMessage: string, blockedMessage: string): string {
  const label = raw.trim();
  if (!label || label.length > LABEL_MAX || /[\r\n<>]/.test(label)) {
    throw new HostInputError(shapeMessage);
  }
  if (guard.check({ kind: "message", text: label }).outcome !== "allow") {
    throw new HostInputError(blockedMessage);
  }
  return label;
}

function requireCount(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INVITE_COUNT) {
    throw new HostInputError("invite count must be a whole number from 1 to 20");
  }
  return count;
}
