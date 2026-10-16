import type { FastifyInstance } from "fastify";
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

/**
 * Local setup for `npm run room:new`. The invite secret stays in this process.
 * The response carries the host agent credential once. It is not audited.
 */
export function registerHostCommand(app: FastifyInstance, deps: RoomDeps): void {
  app.post("/host/room", async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw RoomHttpError.forbidden();
    }
    try {
      const body = readBody(request.body);
      const origin = requireHttpsOrigin(process.env.COMMONA_PUBLIC_ORIGIN);
      const created = createHostRoom(deps, body, origin);
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof HostInputError) {
        return reply.code(400).send({ error: { message: error.message } });
      }
      throw error;
    }
  });
}

interface HostRoomBody {
  title: string;
  hostName: string;
  inviteCount: number;
}

export interface HostRoomResult {
  invites: string[];
  credential: string;
}

function createHostRoom(deps: RoomDeps, body: HostRoomBody, origin: string): HostRoomResult {
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
      assertClean(deps, invites, [credential, opened.sessionToken]);
      return { invites, credential };
    });
    return write();
  } catch (error) {
    for (const id of inviteIds) dropInviteSecret(id);
    throw error;
  }
}

function assertClean(deps: RoomDeps, invites: readonly string[], hidden: readonly string[]): void {
  const details = deps.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  const auditText = details.map((row) => row.detail_json).join("\n");
  for (const secret of hidden) {
    if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) throw new HostInputError("room:new failed");
    if (invites.some((url) => url.includes(secret)) || auditText.includes(secret)) {
      throw new HostInputError("room:new failed");
    }
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
