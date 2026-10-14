import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import type BetterSqlite3 from "better-sqlite3";
import { expect } from "vitest";
import {
  verifyAuditChain,
  type AuditRecord,
  type Clock,
  type ItemKind,
  type SharingLevel,
} from "../../contract/index.js";
import { openDatabase } from "../../src/db.js";
import { createWakeService, type WakeService, type WakeServiceOptions } from "../../src/wakeup/index.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";
import { startMailSink } from "../helpers/mailSink.js";
import { startWebhookSink, type WebhookHit } from "../helpers/webhookSink.js";

export const WHEN = "2026-01-02T03:04:05.006Z";
export const ROOM_ID = "room_1";
export const MESSAGE_TEXT = "Please file this under questions.";

type Sqlite = BetterSqlite3.Database;

export interface RoomContext {
  db: Sqlite;
  webhook: Awaited<ReturnType<typeof startWebhookSink>>;
  mail: Awaited<ReturnType<typeof startMailSink>>;
  clock: Clock;
  sleeps: number[];
  service: WakeService;
}

export async function setupRoom(options?: { sameOwnerAgent?: boolean }): Promise<RoomContext> {
  const db = openDatabase(":memory:");
  const webhook = await startWebhookSink();
  const mail = await startMailSink();
  const clock: Clock = { now: () => new Date(WHEN) };
  const sleeps: number[] = [];
  try {
    const pack = loadFixtures();
    seedFixtures(db, pack);
    if (options?.sameOwnerAgent) {
      db.prepare(
        `INSERT INTO agents (id, owner_id, display_name, email, webhook_url)
         VALUES ('A1b', 'O1', 'Agent One B', 'a1b@example.test', ?)`,
      ).run(webhook.url);
    }
    db.prepare(
      "INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, 'O1')",
    ).run(ROOM_ID, WHEN);
    const members: Array<[string, string]> = [
      ["A1", "O1"],
      ["A2", "O2"],
    ];
    if (options?.sameOwnerAgent) members.push(["A1b", "O1"]);
    const insertMember = db.prepare(
      "INSERT INTO memberships (room_id, agent_id, owner_id, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const [agentId, ownerId] of members) insertMember.run(ROOM_ID, agentId, ownerId, WHEN);
    const point = db.prepare("UPDATE agents SET webhook_url = ? WHERE id = ?");
    for (const agent of pack.agents) point.run(webhook.url, agent.id);
    const service = createWakeService({
      db,
      clock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      smtp: { host: mail.host, port: mail.port },
    });
    return { db, webhook, mail, clock, sleeps, service };
  } catch (error) {
    await webhook.stop().catch(() => undefined);
    await mail.stop().catch(() => undefined);
    db.close();
    throw error;
  }
}

export function useService(ctx: RoomContext, overrides: Partial<WakeServiceOptions> = {}): WakeService {
  const service = createWakeService({
    db: ctx.db,
    clock: ctx.clock,
    sleep: async (ms) => {
      ctx.sleeps.push(ms);
    },
    smtp: { host: ctx.mail.host, port: ctx.mail.port },
    ...overrides,
  });
  ctx.service = service;
  ctx.sleeps.length = 0;
  return service;
}

export async function stopRoom(ctx: RoomContext): Promise<void> {
  await ctx.webhook.stop();
  await ctx.mail.stop();
  ctx.db.close();
}

export function insertMessage(
  db: Sqlite,
  args: { id?: string; text?: string; round?: number; held?: boolean; replyToId?: string | null; authorAgentId?: string; authorOwnerId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO posts (
       id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'thread_1', ?, ?, ?)`,
  ).run(
    args.id ?? "post_1",
    ROOM_ID,
    args.authorAgentId ?? "A1",
    args.authorOwnerId ?? "O1",
    args.text ?? MESSAGE_TEXT,
    args.replyToId ?? null,
    args.round ?? 1,
    args.held ? 1 : 0,
    WHEN,
  );
}

export function insertFile(
  db: Sqlite,
  args: {
    id?: string;
    name?: string;
    mediaType?: string;
    bytes?: Buffer;
    metadata?: Record<string, string>;
    held?: boolean;
  } = {},
): void {
  const bytes = args.bytes ?? Buffer.from("The checklist is complete.");
  db.prepare(
    `INSERT INTO files (
       id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
       byte_length, held, created_at
     ) VALUES (?, ?, 'A1', 'O1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id ?? "file_1",
    ROOM_ID,
    args.name ?? "notes.txt",
    args.mediaType ?? "text/plain",
    bytes,
    JSON.stringify(args.metadata ?? { topic: "questions" }),
    bytes.length,
    args.held ? 1 : 0,
    WHEN,
  );
}

export function setSharing(db: Sqlite, fromOwnerId: string, toOwnerId: string, level: SharingLevel): void {
  db.prepare(
    `INSERT INTO sharing (room_id, from_owner_id, to_owner_id, level)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, from_owner_id, to_owner_id) DO UPDATE SET level = excluded.level`,
  ).run(ROOM_ID, fromOwnerId, toOwnerId, level);
}

export function clearWebhook(db: Sqlite, agentId: string): void {
  db.prepare("UPDATE agents SET webhook_url = NULL WHERE id = ?").run(agentId);
}

export function readAudit(db: Sqlite): AuditRecord[] {
  const rows = db
    .prepare(
      `SELECT id, seq, ts, room, agent_id AS agentId, owner_id AS ownerId, action, result,
              detail_json AS detailJson, prev_hash AS prevHash, hash
       FROM audit_log ORDER BY seq`,
    )
    .all() as Array<{
    id: string;
    seq: number;
    ts: string;
    room: string;
    agentId: string;
    ownerId: string;
    action: AuditRecord["action"];
    result: AuditRecord["result"];
    detailJson: string;
    prevHash: string;
    hash: string;
  }>;
  const records = rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    room: row.room,
    agentId: row.agentId,
    ownerId: row.ownerId,
    action: row.action,
    result: row.result,
    detail: JSON.parse(row.detailJson) as AuditRecord["detail"],
    prevHash: row.prevHash,
    hash: row.hash,
  }));
  return records;
}

export function expectChain(db: Sqlite): AuditRecord[] {
  const records = readAudit(db);
  expect(verifyAuditChain(records)).toEqual({ ok: true });
  return records;
}

export function hitsFor(hits: WebhookHit[], agentId: string): WebhookHit[] {
  return hits.filter((hit) => {
    const body = hit.json as { recipient?: { agentId?: string } } | null;
    return body?.recipient?.agentId === agentId;
  });
}

export function enqueueInput(args: { itemKind?: ItemKind; itemId?: string; round?: number; authorAgentId?: string; authorOwnerId?: string } = {}) {
  return {
    roomId: ROOM_ID,
    authorAgentId: args.authorAgentId ?? "A1",
    authorOwnerId: args.authorOwnerId ?? "O1",
    itemKind: args.itemKind ?? "message",
    itemId: args.itemId ?? "post_1",
    round: args.round ?? 1,
  };
}

export async function startSlowServer(delayMs: number, status: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.end();
    }, delayMs);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

export async function startRedirectServer(location: string): Promise<{ url: string; hits: number; stop: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 302;
    res.setHeader("location", location);
    res.end();
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    get hits() {
      return hits;
    },
    stop: () => closeServer(server),
  };
}

export async function startResetServer(): Promise<{ host: string; port: number; stop: () => Promise<void> }> {
  const server = createNetServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("reset server did not bind");
  return {
    host: "127.0.0.1",
    port: address.port,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
