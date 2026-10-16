import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { newId, SharingLevel, systemClock, type AuditLog, type Clock, type TokenStore } from "../contract/index.js";
import { startMcpHttp, type McpHttpServer } from "../connectors/mcp-server/http.js";
import { createAuditLog } from "../src/audit/log.js";
import { createTokenStore } from "../src/auth/store.js";
import { openDatabase } from "../src/db.js";
import { spoolHandoff, startWakeListener, type WakeListener } from "../src/listener/index.js";
import { setInviteLog } from "../src/join/log.js";
import { createOwnerNotifier } from "../src/notices/store.js";
import { openAccount } from "../src/onboarding/account.js";
import { connectorUrl, issueConnectLink } from "../src/onboarding/connect.js";
import { buildApp } from "../src/app.js";
import { createSharingDirectory } from "../src/sharing/index.js";
import { createWakeService } from "../src/wakeup/index.js";

/** First line of the git-ignored transcript. It is a developer log of fake data. */
export const ARTIFACT_HEADER = "TEST ARTIFACT - developer log, fake data, not a product view";

export const ARTIFACT_PATH = "test-artifacts/demo-lunch-transcript.log";

/** Present in every room message so a test can prove stdout never prints one. */
export const MESSAGE_CANARY = "LUNCH-TEXT-CANARY";

export const LUNCH_PLACE = "North Cafe";

export interface LunchSlot {
  day: string;
  time: string;
  place: string;
}

export const DEMO_OWNERS = [
  { key: "orla", name: "Orla (demo)", firstName: "Orla" },
  { key: "pim", name: "Pim (demo)", firstName: "Pim" },
  { key: "tavi", name: "Tavi (demo)", firstName: "Tavi" },
] as const;

export type DemoOwnerKey = (typeof DEMO_OWNERS)[number]["key"];

/** Fixed proposals. Exactly one slot is in all three lists. */
export const PROPOSALS: Record<DemoOwnerKey, readonly LunchSlot[]> = {
  orla: [
    { day: "Tue", time: "12:00", place: LUNCH_PLACE },
    { day: "Wed", time: "12:30", place: LUNCH_PLACE },
    { day: "Thu", time: "13:00", place: LUNCH_PLACE },
  ],
  pim: [
    { day: "Wed", time: "12:30", place: LUNCH_PLACE },
    { day: "Fri", time: "12:00", place: LUNCH_PLACE },
    { day: "Sat", time: "13:00", place: LUNCH_PLACE },
  ],
  tavi: [
    { day: "Mon", time: "11:30", place: LUNCH_PLACE },
    { day: "Wed", time: "12:30", place: LUNCH_PLACE },
    { day: "Sun", time: "12:00", place: LUNCH_PLACE },
  ],
};

export interface DemoOwner {
  key: DemoOwnerKey;
  name: string;
  ownerId: string;
  agentId: string;
}

export interface AuditMeta {
  seq: number;
  action: string;
  result: string;
  ownerId: string;
  detail: Record<string, string | number>;
}

export interface LunchDemoResult {
  ok: boolean;
  error: string;
  roomId: string;
  owners: DemoOwner[];
  agreed: LunchSlot | null;
  /** Text each connector actually returned. Message bodies live here and in the artifact. */
  connectorText: Record<DemoOwnerKey, string>;
  stdout: string;
  serverLog: string;
  artifactPath: string;
  secrets: string[];
  auditMeta: AuditMeta[];
  db: Database.Database;
  audit: AuditLog;
  stop: () => Promise<void>;
}

export function slotText(slot: LunchSlot): string {
  return `${slot.day} ${slot.time} ${slot.place}`;
}

export function proposalText(slots: readonly LunchSlot[]): string {
  return `proposal ${slots.map(slotText).join(" | ")} ${MESSAGE_CANARY}`;
}

export function agreementText(slot: LunchSlot): string {
  return `agreed ${slotText(slot)} ${MESSAGE_CANARY}`;
}

export function parseSlots(text: string): LunchSlot[] {
  const found: LunchSlot[] = [];
  const place = LUNCH_PLACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\\d{2}:\\d{2}) ${place}\\b`, "g");
  for (const match of text.matchAll(pattern)) {
    const day = match[1];
    const time = match[2];
    if (!day || !time) continue;
    found.push({ day, time, place: LUNCH_PLACE });
  }
  return found;
}

/** The slots named in a proposal line. */
export function proposalSlots(text: string): LunchSlot[] {
  if (!text.startsWith("proposal ")) return [];
  return parseSlots(text);
}

export function agreedSlot(text: string): LunchSlot | null {
  if (!text.startsWith("agreed ")) return null;
  return parseSlots(text)[0] ?? null;
}

export function sameSlot(left: LunchSlot, right: LunchSlot): boolean {
  return left.day === right.day && left.time === right.time && left.place === right.place;
}

export function overlap(lists: readonly (readonly LunchSlot[])[]): LunchSlot[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  if (!first) return [];
  return first.filter((slot) => rest.every((list) => list.some((other) => sameSlot(slot, other))));
}

const STDOUT_RE = /^(?:pass|fail) [a-z0-9-]+$|^(?:members|messages|rounds|time) [0-9]+$/;

export function stdoutIsReport(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => STDOUT_RE.test(line));
}

interface Hit {
  status: number;
  body: string;
  setCookies: string[];
}

class DemoError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DemoError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  baseUrl: string,
  method: string,
  urlPath: string,
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
  const response = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  return {
    status: response.status,
    body: await response.text(),
    setCookies: response.headers.getSetCookie(),
  };
}

function absorb(jar: Map<string, string>, setCookies: string[]): void {
  for (const header of setCookies) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function nonceOf(html: string): string {
  return /name="nonce" value="([^"]*)"/.exec(html)?.[1] ?? "";
}

interface ToolSession {
  endpoint: string;
  base: string;
  id: string;
  next: number;
  texts: string[];
}

async function rpc(session: ToolSession, method: string, params: unknown, note = false): Promise<unknown> {
  const payload = note
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: session.next++, method, params };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session.id) headers["mcp-session-id"] = session.id;
  const response = await fetch(session.endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = response.headers.get("mcp-session-id");
  if (sid) session.id = sid;
  const text = await response.text();
  if (note) {
    if (response.status !== 202 && response.status !== 200) throw new DemoError("rpc");
    return null;
  }
  if (response.status !== 200) throw new DemoError("rpc");
  const parsed = JSON.parse(text) as { result?: unknown; error?: unknown };
  if (parsed.error) throw new DemoError("rpc");
  return parsed.result;
}

function toolText(result: unknown): string {
  const content = (result as { content?: { text?: string }[]; isError?: boolean }).content;
  if ((result as { isError?: boolean }).isError) throw new DemoError("tool");
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new DemoError("tool");
  return text;
}

async function callTool(session: ToolSession, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await rpc(session, "tools/call", { name, arguments: args });
  const text = toolText(result);
  session.texts.push(text);
  return text;
}

interface LiveAgent {
  key: DemoOwnerKey;
  name: string;
  ownerId: string;
  agentId: string;
  session: ToolSession;
  mcp: McpHttpServer;
  listener: WakeListener;
  spool: string;
}

export async function runLunchDemo(options: { artifactPath?: string } = {}): Promise<LunchDemoResult> {
  const started = Date.now();
  const artifactPath = options.artifactPath ?? ARTIFACT_PATH;
  const lines: string[] = [];
  const serverLines: string[] = [];
  const secrets: string[] = [];
  const owners: DemoOwner[] = [];
  const connectorText: Record<DemoOwnerKey, string> = { orla: "", pim: "", tavi: "" };
  let agreed: LunchSlot | null = null;
  let roomId = "";
  let failed = "";
  let members = 0;
  let messages = 0;
  let rounds = 0;

  const emit = (line: string) => {
    if (!STDOUT_RE.test(line)) return;
    lines.push(line);
    process.stdout.write(`${line}\n`);
  };

  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${ARTIFACT_HEADER}\n`, "utf8");
  const transcript = (line: string) => {
    if (secrets.some((secret) => secret.length > 0 && line.includes(secret))) return;
    appendFileSync(artifactPath, `${line}\n`, "utf8");
  };

  setInviteLog((line) => {
    serverLines.push(line);
  });

  const clock: Clock = systemClock;
  const db = openDatabase(":memory:");
  const tokens: TokenStore = createTokenStore(db);
  const audit = createAuditLog(db, clock);
  const sharing = createSharingDirectory(db);
  const notices = createOwnerNotifier(db, clock);
  const wake = createWakeService({
    db,
    clock,
    audit,
    notices,
    // The listener is http://127.0.0.1. The product flag is off; this rehearsal turns it on.
    allowInsecureLocalhost: true,
  });
  const app = buildApp({
    db,
    clock,
    tokens,
    audit,
    sharing,
    notices,
    wakeQueue: wake,
    deliverWake: (wakeId) => wake.deliver(wakeId).then(() => undefined),
    smtp: null,
  });
  const live: LiveAgent[] = [];
  const spools: string[] = [];
  const listeners: WakeListener[] = [];
  const mcps: McpHttpServer[] = [];
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    setInviteLog(() => {});
    for (const mcp of mcps) await mcp.close().catch(() => undefined);
    for (const listener of listeners) await listener.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    if (db.open) db.close();
    await Promise.all(spools.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  };

  const finish = (): LunchDemoResult => {
    const stdout = `${lines.join("\n")}\n`;
    return {
      ok: failed === "" && agreed !== null,
      error: failed,
      roomId,
      owners,
      agreed,
      connectorText,
      stdout,
      serverLog: serverLines.join("\n"),
      artifactPath,
      secrets,
      auditMeta: readAuditMeta(db),
      db,
      audit,
      stop,
    };
  };

  const run = async (name: string, fn: () => Promise<void>) => {
    if (failed) return;
    try {
      await fn();
      emit(`pass ${name}`);
    } catch (error) {
      failed = error instanceof Error ? error.message : name;
      emit(`fail ${name}`);
    }
  };

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new DemoError("bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    let orlaToken = "";
    let orla: DemoOwner | undefined;

    await run("create-room", async () => {
      const account = openAccount(db, tokens);
      secrets.push(account.sessionToken);
      orlaToken = account.sessionToken;
      db.prepare("UPDATE owners SET display_name = ? WHERE id = ?").run("Orla (demo)", account.ownerId);
      const created = await request(baseUrl, "POST", "/rooms", { token: orlaToken, json: {} });
      if (created.status !== 201) throw new DemoError("create-room");
      roomId = (JSON.parse(created.body) as { room: { id: string } }).room.id;
      db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(roomId, "Lunch");
      const joined = await request(baseUrl, "POST", `/rooms/${roomId}/members`, {
        token: orlaToken,
        json: { agentId: account.agentId },
      });
      if (joined.status !== 201 && joined.status !== 200) throw new DemoError("create-room");
      orla = { key: "orla", name: "Orla (demo)", ownerId: account.ownerId, agentId: account.agentId };
      owners.push(orla);
      transcript("owner Orla (demo) created room Lunch");
    });

    const inviteIds: string[] = [];
    await run("invite-links", async () => {
      if (!orlaToken || !roomId) throw new DemoError("invite-links");
      for (let n = 0; n < 2; n += 1) {
        const created = await request(baseUrl, "POST", `/rooms/${roomId}/invites`, { token: orlaToken, json: {} });
        if (created.status !== 201) throw new DemoError("invite-links");
        const id = (JSON.parse(created.body) as { invite: { id: string; link: string } }).invite.id;
        inviteIds.push(id);
      }
      if (inviteIds.length !== 2) throw new DemoError("invite-links");
      transcript("owner Orla (demo) created 2 invite links");
    });

    const friendTokens = new Map<DemoOwnerKey, string>();
    const friendJars = new Map<DemoOwnerKey, Map<string, string>>();

    const joinFriend = async (key: "pim" | "tavi", inviteId: string) => {
      const spec = DEMO_OWNERS.find((owner) => owner.key === key);
      if (!spec) throw new DemoError("join");
      const jar = new Map<string, string>();
      const welcome = await request(baseUrl, "GET", `/j/${inviteId}`, { accept: "text/html" });
      if (welcome.status !== 200) throw new DemoError("join");
      if (!welcome.body.includes("Lunch") || !welcome.body.includes("Orla (demo)")) throw new DemoError("join");
      absorb(jar, welcome.setCookies);
      const welcomeNonce = nonceOf(welcome.body);
      const named = await request(baseUrl, "POST", `/j/${inviteId}/continue`, {
        cookie: cookieHeader(jar),
        form: { nonce: welcomeNonce, firstName: spec.firstName },
      });
      if (named.status !== 303) throw new DemoError("join");
      const sharingPage = await request(baseUrl, "GET", `/j/${inviteId}/sharing`, {
        accept: "text/html",
        cookie: cookieHeader(jar),
      });
      if (sharingPage.status !== 200) throw new DemoError("join");
      absorb(jar, sharingPage.setCookies);
      const shareNonce = nonceOf(sharingPage.body);
      const finished = await request(baseUrl, "POST", `/j/${inviteId}/finish`, {
        cookie: cookieHeader(jar),
        form: { nonce: shareNonce, seeing: "Messages" },
      });
      if (finished.status !== 303) throw new DemoError("join");
      absorb(jar, finished.setCookies);
      for (const value of jar.values()) {
        if (value.length > 16) secrets.push(value);
      }
      const session = jar.get("commona_session") ?? "";
      if (!session) throw new DemoError("join");
      friendTokens.set(key, session);
      const row = db.prepare("SELECT id FROM owners WHERE display_name = ?").get(spec.firstName) as
        | { id: string }
        | undefined;
      if (!row) throw new DemoError("join");
      db.prepare("UPDATE owners SET display_name = ? WHERE id = ?").run(spec.name, row.id);
      const agent = db.prepare("SELECT agent_id FROM owner_agents WHERE owner_id = ?").get(row.id) as
        | { agent_id: string }
        | undefined;
      if (!agent) throw new DemoError("join");
      owners.push({ key, name: spec.name, ownerId: row.id, agentId: agent.agent_id });
      friendJars.set(key, jar);
      transcript(`owner ${spec.name} joined and chose Messages`);
    };

    await run("join-pim", async () => {
      const id = inviteIds[0];
      if (!id) throw new DemoError("join-pim");
      await joinFriend("pim", id);
    });
    await run("join-tavi", async () => {
      const id = inviteIds[1];
      if (!id) throw new DemoError("join-tavi");
      await joinFriend("tavi", id);
    });

    await run("sharing", async () => {
      const byKey = new Map(owners.map((owner) => [owner.key, owner]));
      const pairs: Array<[DemoOwnerKey, DemoOwnerKey]> = [
        ["orla", "pim"],
        ["orla", "tavi"],
        ["pim", "orla"],
        ["pim", "tavi"],
        ["tavi", "orla"],
        ["tavi", "pim"],
      ];
      for (const [fromKey, toKey] of pairs) {
        const from = byKey.get(fromKey);
        const to = byKey.get(toKey);
        if (!from || !to) throw new DemoError("sharing");
        const token = fromKey === "orla" ? orlaToken : friendTokens.get(fromKey);
        if (!token) throw new DemoError("sharing");
        const updated = await request(baseUrl, "PUT", `/rooms/${roomId}/sharing`, {
          token,
          json: { fromOwnerId: from.ownerId, toOwnerId: to.ownerId, level: SharingLevel.Messages },
        });
        if (updated.status !== 200) throw new DemoError("sharing");
      }
      transcript("sharing Messages set for every owner pair");
    });

    const connectOwner = async (key: DemoOwnerKey, inviteForLink: string) => {
      const owner = owners.find((item) => item.key === key);
      if (!owner) throw new DemoError("connect");
      const spool = await mkdtemp(path.join(tmpdir(), "commona-lunch-"));
      spools.push(spool);
      const listener = await startWakeListener({ handoff: spoolHandoff(spool) });
      listeners.push(listener);
      const mcp = await startMcpHttp({ config: { baseUrl, wakePollMs: 20, wakeSpool: spool } });
      mcps.push(mcp);
      let handoffUrl = "";
      if (key === "orla") {
        const issued = issueConnectLink(
          { db, clock, tokens },
          owner.ownerId,
          roomId,
          inviteForLink || newId("inv"),
        );
        secrets.push(issued.secret);
        const url = connectorUrl(mcp.url, issued.secret, roomId);
        if (!url) throw new DemoError("connect");
        handoffUrl = url;
      } else {
        const previous = process.env.COMMONA_CONNECT_URL;
        process.env.COMMONA_CONNECT_URL = mcp.url;
        try {
          const inviteId = key === "pim" ? inviteIds[0] : inviteIds[1];
          if (!inviteId) throw new DemoError("connect");
          const jar = friendJars.get(key);
          if (!jar?.get("commona_session") || !jar.get("commona_joined")) throw new DemoError("connect");
          const page = await openFriendConnect(baseUrl, inviteId, jar);
          const copied = await request(baseUrl, "POST", `/j/${inviteId}/connect/link`, {
            cookie: cookieHeader(jar),
            json: { nonce: nonceOf(page.body) },
          });
          if (copied.status !== 200) throw new DemoError("connect");
          const url = (JSON.parse(copied.body) as { url?: string }).url ?? "";
          const secret = new URL(url).searchParams.get("handoff") ?? "";
          if (secret) secrets.push(secret);
          handoffUrl = url;
        } finally {
          if (previous === undefined) delete process.env.COMMONA_CONNECT_URL;
          else process.env.COMMONA_CONNECT_URL = previous;
        }
      }
      const session: ToolSession = { endpoint: handoffUrl, base: mcp.url, id: "", next: 1, texts: [] };
      await rpc(session, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lunch-demo", version: "0" },
      });
      session.endpoint = session.base;
      await rpc(session, "notifications/initialized", {}, true);
      db.prepare("UPDATE agents SET webhook_url = ? WHERE id = ?").run(`${listener.url}/wake`, owner.agentId);
      live.push({ ...owner, session, mcp, listener, spool });
      transcript(`agent connected for ${owner.name}`);
    };

    await run("connect-orla", async () => {
      await connectOwner("orla", newId("inv"));
    });
    await run("connect-pim", async () => {
      const id = inviteIds[0];
      if (!id) throw new DemoError("connect-pim");
      await connectOwner("pim", id);
    });
    await run("connect-tavi", async () => {
      const id = inviteIds[1];
      if (!id) throw new DemoError("connect-tavi");
      await connectOwner("tavi", id);
    });

    const agentOf = (key: DemoOwnerKey): LiveAgent => {
      const agent = live.find((item) => item.key === key);
      if (!agent) throw new DemoError("agent");
      return agent;
    };

    const postMessage = async (key: DemoOwnerKey, text: string): Promise<{ id: string; round: number }> => {
      const agent = agentOf(key);
      const raw = await callTool(agent.session, "commona_post", { text });
      const parsed = JSON.parse(raw) as { outcome?: string; post?: { id?: string; round?: number } };
      if (parsed.outcome !== "accepted" || !parsed.post?.id || typeof parsed.post.round !== "number") {
        throw new DemoError("post");
      }
      if (parsed.post.round > 3) throw new DemoError("round");
      transcript(`${agent.name}: ${text}`);
      return { id: parsed.post.id, round: parsed.post.round };
    };

    const waitForWakeRow = async (ownerId: string, itemId: string) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const row = db
          .prepare(
            `SELECT 1 AS ok FROM audit_log
             WHERE owner_id = ? AND action = 'wake' AND instr(detail_json, ?) > 0`,
          )
          .get(ownerId, itemId) as { ok: number } | undefined;
        if (row) return;
        await delay(20);
      }
      throw new DemoError("wake");
    };

    await run("propose", async () => {
      const order: DemoOwnerKey[] = ["orla", "pim", "tavi"];
      for (const key of order) {
        const posted = await postMessage(key, proposalText(PROPOSALS[key]));
        const author = owners.find((owner) => owner.key === key);
        if (!author) throw new DemoError("propose");
        for (const other of owners) {
          if (other.ownerId === author.ownerId) continue;
          await waitForWakeRow(other.ownerId, posted.id);
        }
      }
    });

    await run("agree", async () => {
      const tavi = agentOf("tavi");
      const feed = await callTool(tavi.session, "commona_read_feed", {});
      const proposals = [...feed.matchAll(/proposal [^\n"]+/g)].map((match) => match[0] ?? "");
      const lists = proposals.map((line) => proposalSlots(line));
      if (lists.length < 3) throw new DemoError("agree");
      const common = overlap(lists);
      if (common.length !== 1) throw new DemoError("agree");
      const slot = common[0];
      if (!slot) throw new DemoError("agree");
      agreed = slot;
      const posted = await postMessage("tavi", agreementText(slot));
      if (posted.round > 3) throw new DemoError("round");
      for (const other of owners) {
        if (other.key === "tavi") continue;
        await waitForWakeRow(other.ownerId, posted.id);
      }
    });

    await run("deliver", async () => {
      if (!agreed) throw new DemoError("deliver");
      const expected = agreementText(agreed);
      for (const agent of live) {
        const feed = await callTool(agent.session, "commona_read_feed", {});
        const taken = await callTool(agent.session, "commona_take_wakes", {});
        const seen = agent.session.texts.join("\n");
        connectorText[agent.key] = seen;
        if (!feed.includes(expected)) throw new DemoError("deliver");
        if (agent.key === "tavi") {
          if (!seen.includes(expected)) throw new DemoError("deliver");
        } else if (!taken.includes(expected)) {
          const deadline = Date.now() + 3000;
          let got = taken;
          while (!got.includes(expected) && Date.now() < deadline) {
            await delay(30);
            got = await callTool(agent.session, "commona_take_wakes", {});
          }
          if (!got.includes(expected)) throw new DemoError("deliver");
        }
        transcript(`received ${agent.name}: ${slotText(agreed)}`);
      }
    });
  } catch (error) {
    if (!failed) {
      failed = error instanceof Error ? error.message : "demo";
      emit("fail demo");
    }
  }

  if (db.open && roomId) {
    const memberRow = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE room_id = ?").get(roomId) as {
      n: number;
    };
    const messageRow = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE room_id = ? AND held = 0").get(roomId) as {
      n: number;
    };
    const roundRow = db.prepare("SELECT COALESCE(MAX(round), 0) AS n FROM posts WHERE room_id = ?").get(roomId) as {
      n: number;
    };
    members = memberRow.n;
    messages = messageRow.n;
    rounds = roundRow.n;
  }
  for (const agent of live) connectorText[agent.key] = agent.session.texts.join("\n");
  emit(`members ${members}`);
  emit(`messages ${messages}`);
  emit(`rounds ${rounds}`);
  emit(`time ${Date.now() - started}`);
  return finish();
}

async function openFriendConnect(baseUrl: string, inviteId: string, jar: Map<string, string>): Promise<Hit> {
  const done = await request(baseUrl, "GET", `/j/${inviteId}/done`, {
    accept: "text/html",
    cookie: cookieHeader(jar),
  });
  if (done.status !== 200) throw new DemoError("connect");
  absorb(jar, done.setCookies);
  const page = await request(baseUrl, "GET", `/j/${inviteId}/connect`, {
    accept: "text/html",
    cookie: cookieHeader(jar),
  });
  if (page.status !== 200) throw new DemoError("connect");
  absorb(jar, page.setCookies);
  if (!page.body.includes("Copy my link")) throw new DemoError("connect");
  return page;
}

function readAuditMeta(db: Database.Database): AuditMeta[] {
  if (!db.open) return [];
  const rows = db
    .prepare("SELECT seq, action, result, owner_id, detail_json FROM audit_log ORDER BY seq")
    .all() as { seq: number; action: string; result: string; owner_id: string; detail_json: string }[];
  return rows.map((row) => {
    const parsed = JSON.parse(row.detail_json) as Record<string, unknown>;
    const detail: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "number") detail[key] = value;
    }
    return { seq: row.seq, action: row.action, result: row.result, ownerId: row.owner_id, detail };
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const result = await runLunchDemo();
  const code = result.ok ? 0 : 1;
  await result.stop();
  process.exit(code);
}
