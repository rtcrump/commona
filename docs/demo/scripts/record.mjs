/**
 * Record the Commona M1 demo from the live API.
 *
 * Run from anywhere:
 *   npx tsx docs/demo/scripts/record.mjs --out /tmp/commona-demo
 *
 * Uses fixture owners O1/O2 and agents A1/A2. The invented patient sentence
 * is built at runtime from fixtures/ and is not written into this file.
 * Timestamps on screen are taken from API bodies and audit rows.
 * This script does not publish the package.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(root);

const AGENDA = "Draft agenda is in tree.md";
const DISPLAY = ":99";
const VIEW_W = 1280;
const VIEW_H = 720;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
const outDir = path.resolve(flag("--out", path.join(tmpdir(), "commona-demo")));
const takeArg = flag("--take", "all");
if (outDir === root || outDir.startsWith(root + path.sep)) {
  throw new Error("refusing to write recordings inside the repository");
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function until(t0, ms) {
  return sleep(Math.max(0, t0 + ms - Date.now()));
}

let state = { phase: "title", caption: "", endVisible: 0 };
function publish(patch) {
  state = { ...state, ...patch };
}

const stageHtml = readFileSync(new URL("./stage.html", import.meta.url));
const ui = createServer((req, res) => {
  if ((req.url || "").startsWith("/state")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(state));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(stageHtml);
});
await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
const uiPort = ui.address().port;
const uiUrl = `http://127.0.0.1:${uiPort}/`;

const {
  HEALTH_NUMBER_PATTERN,
  SHARING_LEVEL_LABEL,
  SharingLevel,
} = await import("../../../contract/index.ts");
const { openDatabase } = await import("../../../src/db.ts");
const { loadFixtures, seedFixtures } = await import("../../../test/helpers/fixtures.ts");

const pack = loadFixtures();
const patientName = pack.names[0];
const healthNumber = new RegExp(HEALTH_NUMBER_PATTERN).exec(pack.notesWithPatient)?.[0];
if (!patientName || !healthNumber) throw new Error("fixture is missing the invented name or health number");
const blockedText = `Notes on ${patientName}, ${healthNumber}`;
const againText = pack.normalMessages.find((line) => line.startsWith("Please confirm the room"));
const replyText = pack.normalMessages.find((line) => line.startsWith("Ready for the next"));
if (!againText || !replyText) throw new Error("fixture is missing a normal message this demo uses");

function blankSides() {
  return {
    a1: { status: "…", statusKind: "member", items: [], note: "" },
    a2: { status: "asleep", statusKind: "asleep", items: [], note: "" },
    sharing: null,
    reverseSharing: null,
    wake: null,
    block: null,
    logs: null,
    roomId: null,
    caption: "",
    endVisible: 0,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(port) {
  const hits = [];
  const server = createServer((req, res) => {
    void readBody(req)
      .then((raw) => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        hits.push({ raw, json, receivedAt: Date.now() });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ hits, server }));
  });
}

const sinks = {
  A1: await listen(18081),
  A2: await listen(18082),
  AX: await listen(18083),
};

let session = null;

async function startSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "commona-demo-"));
  const dbPath = path.join(dir, "demo.sqlite");
  const db = openDatabase(dbPath);
  seedFixtures(db, pack);
  db.close();
  process.env.COMMONA_DB = dbPath;
  delete process.env.COMMONA_SMTP_HOST;
  delete process.env.COMMONA_SMTP_PORT;
  const { buildApp } = await import("../../../src/app.ts");
  const { tokens } = await import("../../../src/auth/index.ts");
  const { defaultRuntime } = await import("../../../src/runtime.ts");
  const app = buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("API did not bind a port");
  session = {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    tokens,
    db: () => defaultRuntime().db,
    events: [],
    ownerTokens: {},
    agentTokens: {},
    roomId: null,
  };
  for (const sink of Object.values(sinks)) sink.hits.length = 0;
}

async function stopSession() {
  if (!session) return;
  await session.app.close();
  session = null;
}

function note(name, fields) {
  session.events.push({ name, ...fields });
}

async function api(method, urlPath, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const response = await fetch(`${session.baseUrl}${urlPath}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text, startedAt, startedMs };
}

function ownerToken(ownerId) {
  if (!session.ownerTokens[ownerId]) session.ownerTokens[ownerId] = session.tokens.issueOwnerToken(ownerId);
  return session.ownerTokens[ownerId];
}

async function createRoom() {
  const res = await api("POST", "/rooms", ownerToken("O1"));
  if (res.status !== 201 || !res.json?.room?.id) throw new Error(`create room failed: ${res.status}`);
  session.roomId = res.json.room.id;
  note("create_room", { roomId: session.roomId, createdAt: res.json.room.createdAt, source: "POST /rooms room.createdAt" });
  publish({ roomId: session.roomId });
  return session.roomId;
}

async function addMember(ownerId, agentId) {
  const res = await api("POST", `/rooms/${session.roomId}/members`, ownerToken(ownerId), { agentId });
  if (res.status !== 201 || !res.json?.token) throw new Error(`add ${agentId} failed: ${res.status} ${res.text}`);
  session.agentTokens[agentId] = res.json.token;
  note("join", {
    agentId,
    ownerId,
    createdAt: res.json.member.createdAt,
    source: "POST /rooms/:roomId/members member.createdAt",
  });
}

function sharingRows() {
  return session.db().prepare(
    `SELECT from_owner_id AS fromOwnerId, to_owner_id AS toOwnerId, level
     FROM sharing WHERE room_id = ? ORDER BY from_owner_id`,
  ).all(session.roomId);
}

function labelOf(level) {
  return SHARING_LEVEL_LABEL[level] ?? level;
}

function publishSharing() {
  const rows = sharingRows();
  const forward = rows.find((row) => row.fromOwnerId === "O1" && row.toOwnerId === "O2");
  const back = rows.find((row) => row.fromOwnerId === "O2" && row.toOwnerId === "O1");
  if (!forward || !back) throw new Error("sharing pair is missing");
  publish({
    sharing: { from: "O1", to: "O2", label: labelOf(forward.level), level: forward.level },
    reverseSharing: { from: "O2", to: "O1", label: labelOf(back.level), level: back.level },
  });
  return rows;
}

async function putSharing(level) {
  const res = await api("PUT", `/rooms/${session.roomId}/sharing`, ownerToken("O1"), {
    fromOwnerId: "O1",
    toOwnerId: "O2",
    level,
  });
  if (res.status !== 200 || res.json?.sharing?.level !== level) {
    throw new Error(`sharing update failed: ${res.status} ${res.text}`);
  }
  const rows = publishSharing();
  note("sharing_put", {
    level,
    label: labelOf(level),
    httpStatus: res.status,
    stored: rows,
    source: "PUT /rooms/:roomId/sharing plus the sharing table",
  });
  return res;
}

async function postAs(agentId, text, name) {
  const before = sinks.A1.hits.length + sinks.A2.hits.length;
  const res = await api("POST", `/rooms/${session.roomId}/posts`, session.agentTokens[agentId], { text });
  if (!res.json?.post?.createdAt) throw new Error(`${name} failed: ${res.status} ${res.text}`);
  note(name, {
    agentId,
    httpStatus: res.status,
    outcome: res.json.outcome,
    createdAt: res.json.post.createdAt,
    block: res.json.block ?? null,
    requestStartedAt: res.startedAt,
    requestStartedMs: res.startedMs,
    sinkHitsBefore: before,
    source: "POST /rooms/:roomId/posts post.createdAt",
  });
  return res;
}

function feedItems(json) {
  return (json.items || []).filter((item) => item.kind === "message").map((item) => ({
    author: `${item.authorAgentId} · ${item.authorOwnerId}`,
    text: item.text,
    at: item.createdAt,
  }));
}

async function readFeed(agentId) {
  const res = await api("GET", `/rooms/${session.roomId}/feed?as=${agentId}`, session.agentTokens[agentId]);
  if (res.status !== 200 || !Array.isArray(res.json?.items)) throw new Error(`feed ${agentId} failed: ${res.status}`);
  note(`feed_${agentId}`, {
    count: res.json.items.length,
    texts: res.json.items.filter((item) => item.kind === "message").map((item) => item.text),
    source: "GET /rooms/:roomId/feed",
  });
  return feedItems(res.json);
}

async function refreshFeeds() {
  const a1 = await readFeed("A1");
  const a2 = await readFeed("A2");
  publish({
    a1: { ...state.a1, items: a1 },
    a2: { ...state.a2, items: a2 },
  });
  return { a1, a2 };
}

async function waitForHit(sink, index, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (sink.hits.length > index) return sink.hits[index];
    await sleep(20);
  }
  throw new Error(`${label} webhook did not arrive within 5s`);
}

function auditRows(json) {
  return (json.entries || []).map((row) => ({
    seq: row.seq,
    ts: row.ts,
    agentId: row.agentId,
    ownerId: row.ownerId,
    action: row.action,
    result: row.result,
    hint: hintOf(row.detail),
    detail: row.detail,
  }));
}

function hintOf(detail) {
  if (!detail) return "";
  const parts = [];
  if (detail.level) parts.push(detail.level);
  if (detail.fromOwnerId && detail.toOwnerId) parts.push(`${detail.fromOwnerId}→${detail.toOwnerId}`);
  if (detail.category) parts.push(detail.category);
  if (detail.location) parts.push(detail.location);
  return parts.join(" ");
}

async function readLog(ownerId) {
  const res = await api("GET", `/log?owner=${ownerId}`, ownerToken(ownerId));
  if (res.status !== 200 || !Array.isArray(res.json?.entries)) throw new Error(`log ${ownerId} failed: ${res.status}`);
  return auditRows(res.json);
}

async function wakeAuditTs() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await readLog("O2");
    const wake = [...rows].reverse().find((row) => row.action === "wake" && row.agentId === "A2" && row.result === "ok");
    if (wake) return wake.ts;
    await sleep(30);
  }
  throw new Error("O2's log has no wake row");
}

async function replyFromWake() {
  const a1Index = sinks.A1.hits.length;
  const res = await postAs("A2", replyText, "a2_reply");
  if (res.json.outcome !== "accepted") throw new Error(`A2 reply was ${res.json.outcome}`);
  publish({
    a2: { ...state.a2, status: "replied", statusKind: "replied" },
    wake: { ...(state.wake || {}), replyAt: res.json.post.createdAt, replyText },
  });
  await refreshFeeds();
  const a1Wake = await waitForHit(sinks.A1, a1Index, "A1");
  note("a1_wake_after_reply", {
    occurredAt: a1Wake.json?.occurredAt ?? null,
    source: "A1 webhook JSON occurredAt",
  });
  return res;
}

async function openRoom() {
  publish({ phase: "room", ...blankSides(), caption: "Different owners, same room" });
  await createRoom();
  await addMember("O1", "A1");
  await addMember("O2", "A2");
  const rows = publishSharing();
  publish({
    a1: { status: "member", statusKind: "member", items: [], note: "" },
    a2: { status: "asleep", statusKind: "asleep", items: [], note: "" },
  });
  note("sharing_after_join", { stored: rows, source: "sharing table after both members joined" });
  return rows;
}

function delta(from, to) {
  if (!from || !to) return null;
  return new Date(to).getTime() - new Date(from).getTime();
}

async function captureWake(postName, hit, options = {}) {
  const event = hit.json;
  const auditTs = await wakeAuditTs();
  const post = session.events.find((entry) => entry.name === postName);
  const noContent = event?.disclosure === "activity_only" && event.content === undefined && !hit.raw.includes(AGENDA);
  note("a2_wake", {
    occurredAt: event?.occurredAt ?? null,
    auditTs,
    disclosure: event?.disclosure ?? null,
    sinkReceivedAt: new Date(hit.receivedAt).toISOString(),
    sinkReceivedAtMs: hit.receivedAt,
    webhookArrivalMs: post ? hit.receivedAt - post.requestStartedMs : null,
    webhookArrivalNote: "webhook sink receivedAt minus Date.now() before the POST. Same shape as the W1 harness. Not drawn on screen.",
    postCreatedAt: post?.createdAt ?? null,
    postToWakeAuditMs: delta(post?.createdAt, auditTs),
    postToOccurredAtMs: delta(post?.createdAt, event?.occurredAt),
    noContent,
    source: "webhook JSON occurredAt, O2 audit wake ts, and the sink clock",
  });
  if (options.show !== false) {
    publish({
      a2: { ...state.a2, status: "webhook received", statusKind: "webhook" },
      wake: {
        occurredAt: event?.occurredAt ?? "",
        auditTs,
        disclosure: event?.disclosure ?? "",
        noContent,
        replyAt: state.wake?.replyAt ?? null,
      },
    });
  }
  if (options.activityOnly && !noContent) throw new Error("expected an activity-only wake with no message text");
  return event;
}

async function runRoomTake(t0) {
  publish({ phase: "title", caption: "", endVisible: 0, roomId: null });
  await until(t0, 2000);
  publish({ phase: "room", caption: "Different owners, same room", ...blankSides() });
  await openRoom();
  await putSharing(SharingLevel.MessagesFiles);
  await putSharingReverse();
  const a2Index = sinks.A2.hits.length;
  const res = await postAs("A1", AGENDA, "agenda_post");
  if (res.json.outcome !== "accepted") throw new Error("agenda post was not accepted");
  const hit = await waitForHit(sinks.A2, a2Index, "A2");
  await captureWake("agenda_post", hit, { show: false });
  const feeds = await refreshFeeds();
  const a2Sees = feeds.a2.some((item) => item.text === AGENDA);
  note("a2_sees_agenda", { a2Sees, source: "GET feed as A2" });
  if (!a2Sees) throw new Error("A2's feed did not include A1's post");
  publish({
    a1: { ...state.a1, status: "member", statusKind: "member" },
    a2: {
      ...state.a2,
      status: "member",
      statusKind: "member",
      note: "A2's feed includes A1's post.",
    },
  });
  await until(t0, 16000);
}

async function putSharingReverse() {
  const res = await api("PUT", `/rooms/${session.roomId}/sharing`, ownerToken("O2"), {
    fromOwnerId: "O2",
    toOwnerId: "O1",
    level: SharingLevel.MessagesFiles,
  });
  if (res.status !== 200) throw new Error(`reverse sharing failed: ${res.status} ${res.text}`);
  publishSharing();
  note("sharing_put_reverse", {
    level: SharingLevel.MessagesFiles,
    httpStatus: res.status,
    source: "PUT /rooms/:roomId/sharing by O2",
  });
}

async function runWakeTake(t0) {
  await until(t0, 2000);
  const a2Index = sinks.A2.hits.length;
  const res = await postAs("A1", AGENDA, "agenda_post");
  if (res.json.outcome !== "accepted") throw new Error("wake post was not accepted");
  await refreshFeeds();
  const hit = await waitForHit(sinks.A2, a2Index, "A2");
  await captureWake("agenda_post", hit, { activityOnly: true });
  publish({ phase: "wake", caption: "A2 woke up and answered. No one relayed it." });
  await sleep(1200);
  const reply = await replyFromWake();
  const wake = session.events.find((entry) => entry.name === "a2_wake");
  note("reply_gap", {
    demoAgentHoldMs: 1200,
    holdNote: "The demo agent waits 1200 ms after the wake is on screen, so the clip can show the webhook before the reply. This wait is not a server measurement.",
    replyCreatedAt: reply.json.post.createdAt,
    wakeAuditTs: wake.auditTs,
    auditToReplyMs: delta(wake.auditTs, reply.json.post.createdAt),
  });
  await until(t0, 16000);
}

async function runFullTake(t0) {
  publish({ phase: "title", caption: "", endVisible: 0, ...blankSides(), roomId: null });
  await until(t0, 5000);
  publish({ phase: "room", caption: "Different owners, same room" });
  const initial = await openRoom();
  if (initial.some((row) => row.level !== SharingLevel.None)) throw new Error("a new pair was not None");
  await until(t0, 8000);
  const a2Index = sinks.A2.hits.length;
  const agenda = await postAs("A1", AGENDA, "agenda_post");
  if (agenda.json.outcome !== "accepted") throw new Error("agenda post was not accepted");
  await refreshFeeds();
  const early = state.a2.items.some((item) => item.text === AGENDA);
  if (early) throw new Error("A2 saw the agenda while sharing was None");
  const hit = await waitForHit(sinks.A2, a2Index, "A2");
  await captureWake("agenda_post", hit, { activityOnly: true });
  await until(t0, 14000);
  publish({ phase: "wake", caption: "A2 woke up and answered. No one relayed it." });
  const reply = await replyFromWake();
  const wake = session.events.find((entry) => entry.name === "a2_wake");
  note("reply_gap", {
    gateNote: "The demo agent posts the reply when the wake shot opens. The webhook itself was already logged. The gap is that wait, not a server measurement.",
    replyCreatedAt: reply.json.post.createdAt,
    wakeAuditTs: wake.auditTs,
    occurredAt: wake.occurredAt,
    auditToReplyMs: delta(wake.auditTs, reply.json.post.createdAt),
  });
  await until(t0, 24000);
  publish({ phase: "sharing", caption: "Sharing starts at None" });
  const stored = publishSharing();
  if (stored.find((row) => row.fromOwnerId === "O1")?.level !== SharingLevel.None) {
    throw new Error("O1 → O2 was not None");
  }
  const secondIndex = sinks.A2.hits.length;
  const second = await postAs("A1", againText, "second_post");
  if (second.json.outcome !== "accepted") throw new Error("second post was not accepted");
  const feeds = await refreshFeeds();
  const hidden = !feeds.a2.some((item) => item.text === againText);
  note("a2_hidden", { hidden, source: "GET feed as A2 after the second post" });
  if (!hidden) throw new Error("A2 saw O1's post at None");
  publish({
    a2: { ...state.a2, note: "O1's latest post is not in this feed." },
  });
  const secondHit = await waitForHit(sinks.A2, secondIndex, "A2 second");
  note("a2_second_wake", {
    occurredAt: secondHit.json?.occurredAt ?? null,
    disclosure: secondHit.json?.disclosure ?? null,
    noMessage: secondHit.json?.content === undefined && !String(secondHit.raw).includes(againText),
    source: "second A2 webhook after the post at None",
  });
  await until(t0, 34000);
  publish({ phase: "block", caption: "Fake patient name caught before anyone saw it" });
  await putSharing(SharingLevel.Messages);
  const blocked = await postAs("A1", blockedText, "blocked_post");
  if (blocked.json.outcome !== "held" || blocked.json.block?.category !== "name" || blocked.json.block?.location !== "text") {
    throw new Error(`block was ${blocked.json?.outcome} ${blocked.json?.block?.category ?? ""}`);
  }
  if (!blocked.json.post.text.includes(patientName) || !blocked.json.post.text.includes(healthNumber)) {
    throw new Error("held post was not the fixture sentence");
  }
  let notice = null;
  const noticeDeadline = Date.now() + 3000;
  while (Date.now() < noticeDeadline) {
    const res = await api("GET", "/notices", ownerToken("O1"));
    if (res.status !== 200) throw new Error(`notices failed: ${res.status}`);
    notice = (res.json.notices || []).find((item) => item.roomId === session.roomId && item.kind === "block");
    if (notice) break;
    await sleep(40);
  }
  if (!notice) throw new Error("O1 did not get a block notice");
  const heldRes = await api("GET", `/rooms/${session.roomId}/held`, ownerToken("O1"));
  if (heldRes.status !== 200) throw new Error(`held list failed: ${heldRes.status}`);
  const heldItem = (heldRes.json.items || []).find((item) => item.kind === "message" && item.text === blockedText);
  if (!heldItem) throw new Error("O1's held list did not include the post");
  const after = await refreshFeeds();
  const a2Saw = after.a2.some((item) => item.text === blockedText) || after.a1.some((item) => item.text === blockedText);
  if (a2Saw) throw new Error("a feed included the held post");
  const setting = (await readLog("O1")).filter((row) => row.action === "setting_change").at(-1);
  note("block_notice", {
    notice: notice.message,
    noticeAt: notice.createdAt,
    category: notice.category ?? null,
    location: notice.location ?? null,
    postAt: blocked.json.post.createdAt,
    heldAt: heldItem.createdAt,
    settingChangeTs: setting?.ts ?? null,
    a2Saw,
    source: "GET /notices, GET /rooms/:roomId/held, GET /log?owner=O1",
  });
  publish({
    block: {
      text: heldItem.text,
      outcome: blocked.json.outcome,
      category: blocked.json.block.category,
      location: blocked.json.block.location,
      postAt: blocked.json.post.createdAt,
      notice: notice.message,
      noticeAt: notice.createdAt,
    },
    a2: { ...state.a2, note: "The held post is not in this feed." },
    a1: { ...state.a1, note: "Held. Not in A1's feed." },
  });
  await until(t0, 48000);
  const logs = { O1: await readLog("O1"), O2: await readLog("O2") };
  const actions = new Set([...logs.O1, ...logs.O2].map((row) => row.action));
  for (const required of ["post", "wake", "setting_change", "block"]) {
    if (!actions.has(required)) throw new Error(`audit log is missing ${required}`);
  }
  note("audit", {
    o1: logs.O1.map(stripDetail),
    o2: logs.O2.map(stripDetail),
    source: "GET /log?owner=O1 and GET /log?owner=O2",
  });
  publish({ phase: "audit", caption: "Every action, logged. Append-only.", logs });
  await until(t0, 55000);
  publish({ phase: "end", caption: "", endVisible: 1 });
  await until(t0, 55800);
  publish({ endVisible: 2 });
  await until(t0, 56600);
  publish({ endVisible: 3 });
  await until(t0, 57400);
  publish({ endVisible: 4 });
  await until(t0, 58500);
  publish({ endVisible: 5 });
  await until(t0, 60000);
}

function stripDetail(row) {
  return {
    seq: row.seq,
    ts: row.ts,
    agentId: row.agentId,
    ownerId: row.ownerId,
    action: row.action,
    result: row.result,
    hint: row.hint,
  };
}

function spawnReady(command, commandArgs, ready) {
  const child = spawn(command, commandArgs, { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${command} did not become ready`)), 10000);
    const check = () => {
      if (ready()) {
        clearTimeout(timer);
        resolve(child);
        return;
      }
      setTimeout(check, 50);
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${command} exited ${code}`));
    });
    check();
  });
}

const xvfb = await spawnReady(
  "Xvfb",
  [DISPLAY, "-screen", "0", `${VIEW_W}x${VIEW_H}x24`, "-nolisten", "tcp", "-ac"],
  () => existsSync("/tmp/.X11-unix/X99"),
);

const chromeProfile = mkdtempSync(path.join(tmpdir(), "commona-chrome-"));
const chrome = spawn("google-chrome", [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--hide-scrollbars",
  "--disable-features=Translate,InfiniteSessionRestore",
  `--user-data-dir=${chromeProfile}`,
  "--kiosk",
  "--window-position=0,0",
  `--window-size=${VIEW_W},${VIEW_H}`,
  "--force-device-scale-factor=1",
  uiUrl,
], { env: { ...process.env, DISPLAY }, stdio: "ignore" });
await sleep(2500);

function startFfmpeg(file) {
  const child = spawn("ffmpeg", [
    "-y",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", "30",
    "-video_size", `${VIEW_W}x${VIEW_H}`,
    "-i", `${DISPLAY}.0`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-crf", "18",
    "-movflags", "+faststart",
    file,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  return async () => {
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));
  };
}

async function recordTake(name, file, run) {
  await startSession();
  try {
    publish({ phase: "title", caption: "", endVisible: 0, roomId: null, ...blankSides() });
    if (name === "wake") {
      await openRoom();
      publish({
        phase: "room",
        caption: "Different owners, same room",
        roomId: session.roomId,
        a1: { status: "member", statusKind: "member", items: [], note: "" },
        a2: { status: "asleep", statusKind: "asleep", items: [], note: "" },
        sharing: state.sharing,
        reverseSharing: state.reverseSharing,
      });
    }
    await sleep(400);
    const stop = startFfmpeg(file);
    await sleep(300);
    const t0 = Date.now();
    if (name === "room") await runRoomTake(t0);
    else if (name === "wake") await runWakeTake(t0);
    else await runFullTake(t0);
    await sleep(200);
    await stop();
    const finishedAt = new Date().toISOString();
    return { file, events: session.events, finishedAt, recordingStartedAt: new Date(t0).toISOString() };
  } finally {
    await stopSession();
  }
}

const takes = [];
const wanted = takeArg === "all" ? ["room", "wake", "full"] : [takeArg];
const files = {
  room: path.join(outDir, "room_two_owners_one_room.mp4"),
  wake: path.join(outDir, "wake_up_agent_a2.mp4"),
  full: path.join(outDir, "full_demo_60s.mp4"),
};

try {
  for (const name of wanted) {
    if (!files[name]) throw new Error(`unknown take ${name}`);
    console.log(`recording ${name}`);
    const result = await recordTake(name, files[name], null);
    takes.push({ take: name, ...result });
    console.log(`recorded ${name}`);
  }
} finally {
  chrome.kill("SIGTERM");
  xvfb.kill("SIGTERM");
  ui.close();
  for (const sink of Object.values(sinks)) {
    await new Promise((resolve) => sink.server.close(() => resolve()));
  }
}

let m1 = null;
try {
  const report = JSON.parse(readFileSync(path.join(root, "m1-report.json"), "utf8"));
  m1 = {
    source: "m1-report.json from npm run m1 on this checkout, before the clips",
    ran: report.summary.ran,
    passed: report.summary.passed,
    failed: report.summary.failed,
    w1MaxLatencyMs: report.w1MaxLatencyMs,
    w1Note: "Maximum of the ten webhook arrival times in that harness run. Not drawn on the clips.",
  };
} catch {
  m1 = null;
}

const timings = {
  recordedAt: new Date().toISOString(),
  fakeData: "O1 O2 A1 A2 and the fixture patient sentence. No real names or accounts.",
  onScreenTimes: "ISO timestamps shown in the clips are post.createdAt, wake occurredAt, audit ts, or notice createdAt from that take.",
  m1,
  takes,
};
writeFileSync(path.join(outDir, "demo_timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
console.log(`wrote ${path.join(outDir, "demo_timings.json")}`);
