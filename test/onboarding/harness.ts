import type { Clock, SharingDirectory, TokenStore } from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { buildApp } from "../../src/app.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { createSharingDirectory } from "../../src/sharing/index.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";

export interface Issued {
  kind: "owner" | "agent";
  token: string;
}

export interface JoinHarness {
  db: ReturnType<typeof openDatabase>;
  clock: Clock & { advance(ms: number): void };
  tokens: TokenStore;
  sharing: SharingDirectory;
  issued: Issued[];
  baseUrl: string;
  roomId: string;
  owner: string;
  stop: () => Promise<void>;
}

export function manualClock(start = "2026-04-01T12:00:00.000Z"): Clock & { advance(ms: number): void } {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advance(by: number) {
      ms += by;
    },
  };
}

export async function startJoinHarness(): Promise<JoinHarness> {
  const clock = manualClock();
  const db = openDatabase(":memory:");
  seedFixtures(db, loadFixtures());
  const inner = createTokenStore(db);
  const issued: Issued[] = [];
  const tokens: TokenStore = {
    issueOwnerToken(ownerId: string) {
      const token = inner.issueOwnerToken(ownerId);
      issued.push({ kind: "owner", token });
      return token;
    },
    issueAgentToken(agentId: string) {
      const token = inner.issueAgentToken(agentId);
      issued.push({ kind: "agent", token });
      return token;
    },
    authenticate: (token: string) => inner.authenticate(token),
  };
  const audit = createAuditLog(db, clock);
  const sharing = createSharingDirectory(db);
  const app = buildApp({ db, clock, tokens, audit, sharing });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("join server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const owner = tokens.issueOwnerToken("O1");
  const created = await call(baseUrl, "POST", "/rooms", { token: owner, json: {} });
  const roomId = (JSON.parse(created.body) as { room: { id: string } }).room.id;
  await call(baseUrl, "POST", `/rooms/${roomId}/members`, { token: owner, json: { agentId: "A1" } });
  const ownerTwo = tokens.issueOwnerToken("O2");
  await call(baseUrl, "POST", `/rooms/${roomId}/members`, { token: ownerTwo, json: { agentId: "A2" } });
  return {
    db,
    clock,
    tokens,
    sharing,
    issued,
    baseUrl,
    roomId,
    owner,
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}

export interface Hit {
  status: number;
  body: string;
  location: string | null;
  setCookies: string[];
  contentType: string;
  retryAfter: string | null;
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; json?: unknown; form?: Record<string, string>; accept?: string } = {},
): Promise<Hit> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.accept) headers.accept = opts.accept;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body, redirect: "manual" });
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get("location"),
    setCookies: response.headers.getSetCookie(),
    contentType: response.headers.get("content-type") ?? "",
    retryAfter: response.headers.get("retry-after"),
  };
}

export function cookieValue(setCookies: string[], name: string): string {
  const header = setCookies.find((value) => value.startsWith(`${name}=`));
  if (!header) return "";
  const end = header.indexOf(";");
  return header.slice(name.length + 1, end === -1 ? undefined : end);
}

export interface CreatedInviteLink {
  id: string;
  /** First GET path. It carries the raw secret. Later paths use the id alone. */
  openPath: string;
}

export async function createInvite(room: JoinHarness, expiresInSeconds?: number): Promise<CreatedInviteLink> {
  const created = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
    token: room.owner,
    json: expiresInSeconds === undefined ? {} : { expiresInSeconds },
  });
  if (created.status !== 201) throw new Error(created.body);
  const invite = (JSON.parse(created.body) as { invite: { id: string; link: string } }).invite;
  return { id: invite.id, openPath: new URL(invite.link).pathname };
}

export const CANARIES = [
  "CANARY-POST-7f3a",
  "CANARY-HELD-7f3a",
  "CANARY-FILE-7f3a.txt",
  "CANARY-HELD-FILE-7f3a.txt",
  "CANARY-BYTES-7f3a",
  "CANARY-META-7f3a",
];

export const CANARY_FILE_ID = "file_canary_visible";

export function seedCanaries(db: JoinHarness["db"], roomId: string): void {
  const now = "2026-04-01T12:00:00.000Z";
  db.prepare(
    `INSERT INTO posts (
       id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
       block_category, block_location, created_at
     ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
  ).run("post_canary_visible", roomId, "CANARY-POST-7f3a", "post_canary_visible", now);
  db.prepare(
    `INSERT INTO posts (
       id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
       block_category, block_location, created_at
     ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 1, 'name', 'text', ?)`,
  ).run("post_canary_held", roomId, "CANARY-HELD-7f3a", "post_canary_held", now);
  const visible = Buffer.from("CANARY-BYTES-7f3a");
  db.prepare(
    `INSERT INTO files (
       id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
       byte_length, round, held, block_category, block_location, created_at
     ) VALUES (?, ?, 'A1', 'O1', ?, 'text/plain', ?, ?, ?, 1, 0, NULL, NULL, ?)`,
  ).run(CANARY_FILE_ID, roomId, "CANARY-FILE-7f3a.txt", visible, '{"note":"CANARY-META-7f3a"}', visible.length, now);
  const held = Buffer.from("CANARY-HELD-7f3a");
  db.prepare(
    `INSERT INTO files (
       id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
       byte_length, round, held, block_category, block_location, created_at
     ) VALUES (?, ?, 'A1', 'O1', ?, 'text/plain', ?, '{}', ?, 1, 1, 'name', 'file_name', ?)`,
  ).run("file_canary_held", roomId, "CANARY-HELD-FILE-7f3a.txt", held, held.length, now);
}
