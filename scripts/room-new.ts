import { pathToFileURL } from "node:url";
import { systemClock } from "../contract/index.js";
import { createAuditLog } from "../src/audit/log.js";
import { createTokenStore } from "../src/auth/store.js";
import { openDatabase } from "../src/db.js";
import { guard } from "../src/guard/index.js";
import { setInviteLog } from "../src/join/log.js";
import { ensureInviteSchema } from "../src/join/schema.js";
import { createInvite } from "../src/join/service.js";
import { createOwnerNotifier } from "../src/notices/store.js";
import { openAccount } from "../src/onboarding/account.js";
import type { RoomDeps } from "../src/room/deps.js";
import { addMember, createRoom } from "../src/room/membership.js";
import { createSharingDirectory } from "../src/sharing/index.js";

/** Same limit the join page uses before it falls back to a generic label. */
const LABEL_MAX = 80;
const DEFAULT_INVITE_COUNT = 2;
const MAX_INVITE_COUNT = 20;
const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

class RoomNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomNewError";
  }
}

export interface RoomNewInput {
  dbPath: string | undefined;
  origin: string | undefined;
  title: string;
  hostName: string;
  inviteCount?: string;
}

/**
 * Create a room, add the host's agent, store the title, and create invites.
 * Returns the public invite URLs. The caller prints those and nothing else.
 * Raw tokens and the invite secret are never returned, logged, or written into audit detail.
 */
export function createRoomInvites(input: RoomNewInput): string[] {
  const origin = requireHttpsOrigin(input.origin);
  const dbPath = requireDbPath(input.dbPath);
  const title = requireLabel(input.title, "room title must be a short label", "room title is not allowed");
  const hostName = requireLabel(
    input.hostName,
    "host display name must be a short label",
    "host display name is not allowed",
  );
  const inviteCount = requireCount(input.inviteCount);

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(dbPath);
  } catch {
    throw new RoomNewError("COMMONA_DB could not be opened");
  }

  try {
    const deps = services(db);
    const write = db.transaction(() => {
      const opened = openAccount(db, deps.tokens);
      const ownerId = opened.ownerId;
      const agentId = opened.agentId;
      db.prepare("UPDATE owners SET display_name = ? WHERE id = ?").run(hostName, ownerId);
      const principal = { kind: "owner" as const, ownerId };
      const room = createRoom(deps, principal);
      const added = addMember(deps, principal, room.id, agentId);
      ensureInviteSchema(db);
      db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.id, title);
      const urls: string[] = [];
      for (let index = 0; index < inviteCount; index += 1) {
        const created = createInvite(deps, principal, room.id, {});
        urls.push(`${origin}/j/${created.id}`);
      }
      const hidden = [opened.sessionToken, added.response.token].filter((value): value is string =>
        Boolean(value),
      );
      assertNoSecrets(db, urls, hidden);
      return urls;
    });
    return write();
  } catch (error) {
    if (error instanceof RoomNewError) throw error;
    throw new RoomNewError("room:new failed");
  } finally {
    if (db.open) db.close();
  }
}

function services(db: ReturnType<typeof openDatabase>): RoomDeps {
  const clock = systemClock;
  const notices = createOwnerNotifier(db, clock);
  return {
    db,
    clock,
    tokens: createTokenStore(db),
    audit: createAuditLog(db, clock),
    sharing: createSharingDirectory(db),
    guard,
    notices,
  };
}

function requireHttpsOrigin(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!HTTPS_ORIGIN.test(value)) {
    throw new RoomNewError("COMMONA_PUBLIC_ORIGIN must be an https origin");
  }
  return value;
}

function requireDbPath(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value || value === ":memory:") {
    throw new RoomNewError("COMMONA_DB must be a database file");
  }
  return value;
}

function requireLabel(raw: string, shapeMessage: string, blockedMessage: string): string {
  const label = raw.trim();
  if (!label || label.length > LABEL_MAX || /[\r\n<>]/.test(label)) {
    throw new RoomNewError(shapeMessage);
  }
  if (guard.check({ kind: "message", text: label }).outcome !== "allow") {
    throw new RoomNewError(blockedMessage);
  }
  return label;
}

function requireCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INVITE_COUNT;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new RoomNewError("invite count must be a whole number from 1 to 20");
  }
  const count = Number(raw);
  if (count < 1 || count > MAX_INVITE_COUNT) {
    throw new RoomNewError("invite count must be a whole number from 1 to 20");
  }
  return count;
}

function assertNoSecrets(db: ReturnType<typeof openDatabase>, urls: string[], hidden: readonly string[]): void {
  const details = db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  const auditText = details.map((row) => row.detail_json).join("\n");
  for (const secret of hidden) {
    if (!secret) continue;
    if (urls.some((url) => url.includes(secret)) || auditText.includes(secret)) {
      throw new RoomNewError("room:new failed");
    }
  }
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new RoomNewError("room:new failed");
    }
  }
}

function main(): void {
  // Invite lines go nowhere. The default sink is already empty; keep it that way.
  setInviteLog(() => {});
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3) {
      throw new RoomNewError("room:new needs a room title, a host display name, and an optional invite count");
    }
    const title = args[0] ?? "";
    const hostName = args[1] ?? "";
    const urls = createRoomInvites({
      dbPath: process.env.COMMONA_DB,
      origin: process.env.COMMONA_PUBLIC_ORIGIN,
      title,
      hostName,
      inviteCount: args[2],
    });
    process.stdout.write(`${urls.join("\n")}\n`);
  } catch (error) {
    const message = error instanceof RoomNewError ? error.message : "room:new failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main();
}
