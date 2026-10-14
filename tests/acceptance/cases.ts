import {
  AuditAction,
  AuditResult,
  BlockCategory,
  BlockLocation,
  DOB_CUES,
  GENESIS_PREV_HASH,
  HEALTH_NUMBER_PATTERN,
  NoticeKind,
  ReasonCode,
  SharingLevel,
  UNSCOPED_ROOM,
  WAKE_ATTEMPT_LIMIT,
  WAKE_EMAIL_FROM,
  WAKE_EVENT_TYPE,
  WAKE_RETRY_DELAYS_MS,
  WAKE_WEBHOOK_TIMEOUT_MS,
  l1Key,
  l1Matches,
  ownerActorId,
  sealAuditRecord,
  type AcceptanceTestId,
  type AuditRecord,
  type ExpectedLogRow,
  type WakeEvent,
} from "../../contract/index.js";
import { audit } from "../../src/audit/index.js";
import { openDatabase } from "../../src/db.js";
import { expectRows, type Ctx } from "./ctx.js";
import { AcceptanceFailure, classifyThrown, fail, thrownMessage, type FailureKind } from "./failure.js";
import {
  addMember,
  agentToken,
  createRoom,
  feed,
  fileBody,
  logFor,
  mailsTo,
  noticesFor,
  openPair,
  ownerToken,
  postMessage,
  putSharing,
  request,
  upload,
} from "./http.js";
import { delay, poll, pollAsync } from "./poll.js";
import {
  blocked,
  fixtureAgent,
  joined,
  joinRefused,
  loopStopped,
  ordinary,
  ownerEmail,
  posted,
  readRow,
  retriedAttempts,
  settingChanged,
  settingRefused,
  uploaded,
  wakeFailed,
  wakeFallback,
  woke,
} from "./rows.js";

/** Copied from the W1 sentence. The contract does not export this bound. */
const W1_LIMIT_MS = 60_000;

const BLOCK_NOTICE_BUDGET_MS = 10_000;

const W2_BUDGET_MS =
  WAKE_RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0) + WAKE_WEBHOOK_TIMEOUT_MS * WAKE_ATTEMPT_LIMIT + 5_000;

const TREE_FILE = "tree.md";
const NOTES_FILE = "notes-with-patient.md";

async function roomWithBoth(ctx: Ctx): Promise<string> {
  const roomId = await createRoom(ctx, "O1");
  await addMember(ctx, roomId, "O1", "A1");
  await addMember(ctx, roomId, "O2", "A2");
  return roomId;
}

async function waitForWake(ctx: Ctx, ready: () => boolean, label: string): Promise<void> {
  if (ctx.wakesUnavailable) fail(`${label}: wake delivery already failed in this run`);
  const arrived = await poll(W1_LIMIT_MS, ready);
  if (!arrived) {
    ctx.wakesUnavailable = true;
    fail(`${label}: wake did not arrive within 60 s`);
  }
}

function isWake(value: unknown): value is WakeEvent {
  return typeof value === "object" && value !== null && (value as WakeEvent).type === WAKE_EVENT_TYPE;
}

function assertActivityOnly(event: WakeEvent): void {
  if (event.disclosure !== "activity_only") fail(`wake disclosure was ${event.disclosure}`);
  if (event.content !== undefined) fail("activity-only wake included content");
  if (event.activity.itemKind !== undefined) fail("activity-only wake named the item kind");
}

function combine(problems: { kind: FailureKind; message: string }[]): never {
  const kind = problems.some((problem) => problem.kind === "assertion") ? "assertion" : "not-built";
  throw new AcceptanceFailure(problems.map((problem) => problem.message).join("\n"), kind);
}

export async function test_R1_a1_posts_a2_reads(ctx: Ctx): Promise<void> {
  const text = ordinary(ctx, 0);
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    settingChanged("O1"),
    settingChanged("O2"),
    posted(ctx, "A1"),
    woke(ctx, "A2"),
    readRow(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  await openPair(ctx, roomId, "O1", "O2", SharingLevel.MessagesFiles);
  await openPair(ctx, roomId, "O2", "O1", SharingLevel.MessagesFiles);
  const created = await postMessage(ctx, roomId, "A1", text);
  if (created.outcome !== "accepted") fail(`A1's post was ${created.outcome}`);
  const items = await feed(ctx, roomId, "A2");
  if (!items.some((item) => item.kind === "message" && item.text === text)) fail("A2 cannot read A1's post");
}

export async function test_R2_non_member_refused_and_logged(ctx: Ctx): Promise<void> {
  expectRows(ctx, [joinRefused(ctx, "AX"), joinRefused(ctx, "AX")]);
  const roomId = await createRoom(ctx, "O1");
  const post = await request(ctx, "POST", `/rooms/${roomId}/posts`, agentToken(ctx, "AX"), {
    text: ordinary(ctx, 1),
  });
  if (post.status !== 403) fail(`AX post returned ${post.status}: ${post.text}`);
  const read = await request(ctx, "GET", `/rooms/${roomId}/feed?as=AX`, agentToken(ctx, "AX"));
  if (read.status !== 403) fail(`AX read returned ${read.status}: ${read.text}`);
  const entries = await logFor(ctx, "O3", ownerToken(ctx, "O3"));
  const refusals = entries.filter(
    (row) =>
      row.room === roomId &&
      row.action === AuditAction.JoinRefused &&
      row.result === AuditResult.Refused &&
      row.agentId === "AX" &&
      row.ownerId === "O3",
  );
  if (refusals.length !== 2) fail(`expected 2 join_refused rows for AX and O3, got ${refusals.length}`);
}

export async function test_R3_ten_posts_logged_with_owner(ctx: Ctx): Promise<void> {
  const rows: ExpectedLogRow[] = [joined(ctx, "A1"), joined(ctx, "A2")];
  for (let i = 0; i < 10; i++) {
    const agentId = i % 2 === 0 ? "A1" : "A2";
    const other = agentId === "A1" ? "A2" : "A1";
    rows.push(posted(ctx, agentId), woke(ctx, other));
  }
  expectRows(ctx, rows);
  const roomId = await roomWithBoth(ctx);
  for (let i = 0; i < 10; i++) {
    const agentId = i % 2 === 0 ? "A1" : "A2";
    const created = await postMessage(ctx, roomId, agentId, ordinary(ctx, i % ctx.pack.normalMessages.length));
    if (created.outcome !== "accepted") fail(`post ${i + 1} was ${created.outcome}`);
  }
  const entries = [
    ...(await logFor(ctx, "O1", ownerToken(ctx, "O1"))),
    ...(await logFor(ctx, "O2", ownerToken(ctx, "O2"))),
  ];
  const posts = entries
    .filter((row) => row.room === roomId && row.action === AuditAction.Post)
    .sort((a, b) => a.seq - b.seq);
  if (posts.length !== 10) fail(`log has ${posts.length} post entries for the room`);
  for (let i = 0; i < posts.length; i++) {
    const agentId = i % 2 === 0 ? "A1" : "A2";
    const row = posts[i];
    if (row?.agentId !== agentId || row.ownerId !== fixtureAgent(ctx, agentId).ownerId) {
      fail(`post ${i + 1} logged as ${row?.agentId ?? "?"}/${row?.ownerId ?? "?"}`);
    }
  }
}

export async function test_W1_wake_within_60s_10_of_10(ctx: Ctx): Promise<void> {
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    ...Array.from({ length: 10 }, () => posted(ctx, "A1")),
    ...Array.from({ length: 10 }, () => woke(ctx, "A2")),
  ]);
  const roomId = await roomWithBoth(ctx);
  const latencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = ctx.webhooks.A2.hits.length;
    const started = Date.now();
    const created = await postMessage(ctx, roomId, "A1", ordinary(ctx, i % ctx.pack.normalMessages.length));
    if (created.outcome !== "accepted") fail(`post ${i + 1} was ${created.outcome}`);
    const arrived = await poll(W1_LIMIT_MS, () => ctx.webhooks.A2.hits.length > start);
    const hit = ctx.webhooks.A2.hits[start];
    if (!arrived || !hit) {
      ctx.wakesUnavailable = true;
      fail(`wake ${i + 1} of 10 did not arrive within 60 s`);
    }
    latencies.push(hit.receivedAt - started);
  }
  const max = Math.max(...latencies);
  ctx.metrics.w1MaxLatencyMs = max;
  if (latencies.some((latency) => latency >= W1_LIMIT_MS)) {
    fail(`max latency ${max} ms was not under 60 s`);
  }
}

export async function test_W2_down_retries_then_email_logged(ctx: Ctx): Promise<void> {
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    posted(ctx, "A1"),
    ...retriedAttempts(ctx, "A2"),
    wakeFallback(ctx, "A2"),
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    posted(ctx, "A1"),
    ...retriedAttempts(ctx, "A2"),
    wakeFailed(ctx, "A2"),
  ]);
  ctx.webhooks.A2.setStatus(503);
  const problems: { kind: FailureKind; message: string }[] = [];
  try {
    await wakeFallsBackToEmail(ctx);
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: `email fallback: ${thrownMessage(error)}` });
  }
  try {
    await wakeEmailAlsoFails(ctx);
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: `email failed: ${thrownMessage(error)}` });
  }
  if (problems.length > 0) combine(problems);
}

async function wakeFallsBackToEmail(ctx: Ctx): Promise<void> {
  const roomId = await roomWithBoth(ctx);
  const email = fixtureAgent(ctx, "A2").wake.email;
  const before = mailsTo(ctx, email);
  const created = await postMessage(ctx, roomId, "A1", ordinary(ctx, 2));
  if (created.outcome !== "accepted") fail(`post was ${created.outcome}`);
  const arrived = await poll(W2_BUDGET_MS, () => mailsTo(ctx, email) > before);
  if (!arrived) fail("no email in the sink to A2's address");
  const message = ctx.mail.messages.filter((mail) => mail.to.includes(email)).at(-1);
  if (message?.from !== WAKE_EMAIL_FROM) fail(`fallback email from was ${message?.from ?? "missing"}`);
  const entries = await logFor(ctx, "O2", ownerToken(ctx, "O2"));
  const retries = entries.filter((row) => row.room === roomId && row.action === AuditAction.WakeRetry && row.result === AuditResult.Retried);
  const fallback = entries.filter(
    (row) => row.room === roomId && row.action === AuditAction.WakeFallbackEmail && row.result === AuditResult.FellBack,
  );
  if (retries.length < 1) fail("no wake_retry row was logged");
  if (fallback.length !== 1) fail(`wake_fallback_email rows: ${fallback.length}`);
}

async function wakeEmailAlsoFails(ctx: Ctx): Promise<void> {
  const roomId = await roomWithBoth(ctx);
  ctx.mail.setFailing(true);
  const created = await postMessage(ctx, roomId, "A1", ordinary(ctx, 3));
  if (created.outcome !== "accepted") fail(`post was ${created.outcome}`);
  const notified = await pollAsync(W2_BUDGET_MS, async () => {
    const notices = await noticesFor(ctx, "O2");
    return notices.some((notice) => notice.roomId === roomId && notice.kind === NoticeKind.WakeFailed);
  });
  if (!notified) fail("O2 was not told that the wake failed");
  const entries = await logFor(ctx, "O2", ownerToken(ctx, "O2"));
  const retries = entries.filter((row) => row.room === roomId && row.action === AuditAction.WakeRetry);
  const failed = entries.filter(
    (row) => row.room === roomId && row.action === AuditAction.WakeFailed && row.result === AuditResult.Failed,
  );
  if (retries.length < 1) fail("no wake_retry row was logged when email failed");
  if (failed.length !== 1) fail(`wake_failed rows: ${failed.length}`);
}

export async function test_W3_no_self_wake_and_loop(ctx: Ctx): Promise<void> {
  const problems: { kind: FailureKind; message: string }[] = [];
  try {
    await test_W3_no_self_wake(ctx);
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: `test_W3_no_self_wake: ${thrownMessage(error)}` });
  }
  try {
    await test_W3_stops_after_3_rounds(ctx);
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: `test_W3_stops_after_3_rounds: ${thrownMessage(error)}` });
  }
  if (problems.length > 0) combine(problems);
}

async function test_W3_no_self_wake(ctx: Ctx): Promise<void> {
  expectRows(ctx, [joined(ctx, "A1"), joined(ctx, "A2"), posted(ctx, "A1"), woke(ctx, "A2")]);
  const roomId = await roomWithBoth(ctx);
  const a1before = ctx.webhooks.A1.hits.length;
  const a2before = ctx.webhooks.A2.hits.length;
  const created = await postMessage(ctx, roomId, "A1", ordinary(ctx, 4));
  if (created.outcome !== "accepted") fail(`A1's post was ${created.outcome}`);
  await waitForWake(ctx, () => ctx.webhooks.A2.hits.length > a2before, "no self-wake");
  const ownHits = ctx.webhooks.A1.hits.slice(a1before);
  if (ownHits.length !== 0) fail(`A1's webhook received ${ownHits.length}`);
}

async function test_W3_stops_after_3_rounds(ctx: Ctx): Promise<void> {
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    posted(ctx, "A1"),
    woke(ctx, "A2"),
    posted(ctx, "A2"),
    woke(ctx, "A1"),
    posted(ctx, "A1"),
    woke(ctx, "A2"),
    posted(ctx, "A2"),
    loopStopped(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  const a1 = () => ctx.webhooks.A1.hits.length;
  const a2 = () => ctx.webhooks.A2.hits.length;
  const a1start = a1();
  const a2start = a2();

  const first = await postMessage(ctx, roomId, "A1", ordinary(ctx, 5));
  if (first.outcome !== "accepted" || first.post.round !== 1) fail(`round 1 was ${first.outcome} round ${first.post.round}`);
  await waitForWake(ctx, () => a2() >= a2start + 1, "round 1");

  const second = await postMessage(ctx, roomId, "A2", ordinary(ctx, 6), first.post.id);
  if (second.outcome !== "accepted" || second.post.round !== 2) fail(`round 2 was ${second.outcome} round ${second.post.round}`);
  await waitForWake(ctx, () => a1() >= a1start + 1, "round 2");

  const third = await postMessage(ctx, roomId, "A1", ordinary(ctx, 7), second.post.id);
  if (third.outcome !== "accepted" || third.post.round !== 3) fail(`round 3 was ${third.outcome} round ${third.post.round}`);
  await waitForWake(ctx, () => a2() >= a2start + 2, "round 3");

  if (a1() - a1start !== 1) fail(`A1 received ${a1() - a1start} wakes in the first 3 rounds`);
  if (a2() - a2start !== 2) fail(`A2 received ${a2() - a2start} wakes in the first 3 rounds`);

  const a1atCap = a1();
  const a2atCap = a2();
  const fourth = await postMessage(ctx, roomId, "A2", ordinary(ctx, 8), third.post.id);
  if (fourth.outcome !== "accepted" || fourth.post.round !== 4) {
    fail(`round 4 was ${fourth.outcome} round ${fourth.post.round}`);
  }
  const fourthWake = await poll(W1_LIMIT_MS, () => a1() > a1atCap || a2() > a2atCap);
  if (fourthWake) fail("a 4th wake arrived");

  const entries = await logFor(ctx, "O2", ownerToken(ctx, "O2"));
  const stops = entries.filter(
    (row) => row.room === roomId && row.action === AuditAction.LoopStop && row.result === AuditResult.Ok && row.agentId === "A2",
  );
  if (stops.length !== 1) fail(`loop_stop rows for A2: ${stops.length}`);
  const owners = ["O1", "O2"] as const;
  for (const ownerId of owners) {
    const notices = await noticesFor(ctx, ownerId);
    if (!notices.some((notice) => notice.roomId === roomId && notice.kind === NoticeKind.LoopStop)) {
      fail(`${ownerId} did not get a loop-stop notice`);
    }
  }
}

export async function test_S1_none_a2_sees_nothing(ctx: Ctx): Promise<void> {
  const text = ordinary(ctx, 9);
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    posted(ctx, "A1"),
    uploaded(ctx, "A1"),
    woke(ctx, "A2"),
    woke(ctx, "A2"),
    readRow(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  const wakeStart = ctx.webhooks.A2.hits.length;
  const created = await postMessage(ctx, roomId, "A1", text);
  if (created.outcome !== "accepted") fail(`message was ${created.outcome}`);
  const file = await upload(ctx, roomId, "A1", fileBody(TREE_FILE, ctx.pack.tree));
  if (file.outcome !== "accepted") fail(`${TREE_FILE} was ${file.outcome}`);
  const items = await feed(ctx, roomId, "A2");
  if (items.length !== 0) fail(`A2 saw ${items.length} items at None`);
  const since = () => ctx.webhooks.A2.hits.slice(wakeStart).flatMap((hit) => (isWake(hit.json) ? [hit.json] : []));
  await waitForWake(ctx, () => since().length >= 2, "S1");
  const events = since();
  if (events.length < 2) fail(`A2 received ${events.length} wakes`);
  for (const event of events) assertActivityOnly(event);
}

export async function test_S2_messages_hides_files(ctx: Ctx): Promise<void> {
  const text = ordinary(ctx, 10);
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    settingChanged("O1"),
    posted(ctx, "A1"),
    uploaded(ctx, "A1"),
    woke(ctx, "A2"),
    woke(ctx, "A2"),
    readRow(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  await openPair(ctx, roomId, "O1", "O2", SharingLevel.Messages);
  const created = await postMessage(ctx, roomId, "A1", text);
  const file = await upload(ctx, roomId, "A1", fileBody(TREE_FILE, ctx.pack.tree));
  if (created.outcome !== "accepted" || file.outcome !== "accepted") fail("message or file was held");
  const items = await feed(ctx, roomId, "A2");
  if (!items.some((item) => item.kind === "message" && item.text === text)) fail("A2 did not see the post");
  if (items.some((item) => item.kind === "file")) fail("A2 saw a file at Messages");
  const download = await request(
    ctx,
    "GET",
    `/rooms/${roomId}/files/${file.file.id}`,
    agentToken(ctx, "A2"),
  );
  if (download.status !== 404) fail(`A2 file GET returned ${download.status}`);
}

export async function test_S3_messages_files_both(ctx: Ctx): Promise<void> {
  const text = ordinary(ctx, 11);
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    settingChanged("O1"),
    posted(ctx, "A1"),
    uploaded(ctx, "A1"),
    woke(ctx, "A2"),
    woke(ctx, "A2"),
    readRow(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  await openPair(ctx, roomId, "O1", "O2", SharingLevel.MessagesFiles);
  const created = await postMessage(ctx, roomId, "A1", text);
  const file = await upload(ctx, roomId, "A1", fileBody(TREE_FILE, ctx.pack.tree));
  if (created.outcome !== "accepted" || file.outcome !== "accepted") fail("message or file was held");
  const items = await feed(ctx, roomId, "A2");
  if (!items.some((item) => item.kind === "message" && item.text === text)) fail("A2 did not get the post");
  if (!items.some((item) => item.kind === "file" && item.name === TREE_FILE)) fail(`A2 did not get ${TREE_FILE}`);
}

export async function test_S4_a2_cannot_change_o1_setting(ctx: Ctx): Promise<void> {
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    settingRefused("A2", "O2"),
    settingRefused(ownerActorId("O2"), "O2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  const body = { fromOwnerId: "O1", toOwnerId: "O2", level: SharingLevel.Messages };
  const asAgent = await putSharing(ctx, roomId, agentToken(ctx, "A2"), body);
  if (asAgent.status !== 403) fail(`A2's sharing change returned ${asAgent.status}`);
  const asOwner = await putSharing(ctx, roomId, ownerToken(ctx, "O2"), body);
  if (asOwner.status !== 403) fail(`O2's sharing change returned ${asOwner.status}`);
  const level = sharingLevel(ctx, roomId, "O1", "O2");
  if (level !== SharingLevel.None) fail(`O1→O2 level is ${level ?? "missing"}`);
  const entries = [
    ...(await logFor(ctx, "O2", ownerToken(ctx, "O2"))),
  ];
  const refusals = entries.filter(
    (row) => row.room === roomId && row.action === AuditAction.SettingChangeRefused && row.result === AuditResult.Refused,
  );
  const agents = refusals.map((row) => row.agentId).sort();
  if (agents.join(",") !== ["A2", ownerActorId("O2")].sort().join(",")) {
    fail(`setting_change_refused actors: ${agents.join(", ") || "none"}`);
  }
}

export async function test_S5_new_room_defaults_none(ctx: Ctx): Promise<void> {
  const text = ordinary(ctx, 12);
  expectRows(ctx, [
    joined(ctx, "A1"),
    joined(ctx, "A2"),
    posted(ctx, "A1"),
    uploaded(ctx, "A1"),
    woke(ctx, "A2"),
    woke(ctx, "A2"),
    readRow(ctx, "A2"),
  ]);
  const roomId = await roomWithBoth(ctx);
  const pairs = sharingPairs(ctx, roomId);
  if (pairs.length !== 2) fail(`new room has ${pairs.length} sharing pairs`);
  if (pairs.some((pair) => pair.level !== SharingLevel.None)) fail("a new room pair is not None");
  const directions = pairs.map((pair) => `${pair.fromOwnerId}->${pair.toOwnerId}`).sort();
  if (directions.join(",") !== "O1->O2,O2->O1") fail(`sharing pairs were ${directions.join(", ")}`);
  const created = await postMessage(ctx, roomId, "A1", text);
  const file = await upload(ctx, roomId, "A1", fileBody(TREE_FILE, ctx.pack.tree));
  if (created.outcome !== "accepted" || file.outcome !== "accepted") fail("setup post or file was held");
  const items = await feed(ctx, roomId, "A2");
  if (items.length !== 0) fail(`A2 saw ${items.length} items with no sharing setup`);
}

export async function test_P1_name_in_message_blocked(ctx: Ctx): Promise<void> {
  const name = ctx.pack.names[0];
  if (!name) fail("name list is empty");
  expectRows(ctx, [joined(ctx, "A1"), joined(ctx, "A2"), blocked(ctx, "A1"), readRow(ctx, "A1"), readRow(ctx, "A2")]);
  const roomId = await roomWithBoth(ctx);
  const email = ownerEmail(ctx, "O1");
  const before = mailsTo(ctx, email);
  const created = await postMessage(ctx, roomId, "A1", name);
  if (created.outcome !== "held") fail(`message outcome was ${created.outcome}`);
  if (created.block?.category !== BlockCategory.Name || created.block.location !== BlockLocation.Text) {
    fail(`block was ${created.block?.category ?? "missing"}/${created.block?.location ?? "missing"}`);
  }
  const told = await pollAsync(BLOCK_NOTICE_BUDGET_MS, async () => {
    const mailed = mailsTo(ctx, email) > before;
    const notices = await noticesFor(ctx, "O1");
    return mailed && notices.some((notice) => notice.roomId === roomId && notice.kind === NoticeKind.Block);
  });
  if (!told) fail("O1 was not told");
  const entries = await logFor(ctx, "O1", ownerToken(ctx, "O1"));
  const blocks = entries.filter((row) => row.room === roomId && row.action === AuditAction.Block && row.result === AuditResult.Blocked);
  if (blocks.length !== 1) fail(`block rows: ${blocks.length}`);
  if (blocks[0]?.detail.category !== BlockCategory.Name || blocks[0].detail.location !== BlockLocation.Text) {
    fail("log block category or location was wrong");
  }
  if (entries.some((row) => row.room === roomId && row.action === AuditAction.Post)) {
    fail("blocked message was also logged as post");
  }
  const authorFeed = await feed(ctx, roomId, "A1");
  const otherFeed = await feed(ctx, roomId, "A2");
  if (authorFeed.some((item) => item.kind === "message" && item.text === name)) fail("author feed showed the held message");
  if (otherFeed.some((item) => item.kind === "message" && item.text === name)) fail("A2 saw the held message");
}

export async function test_P2_bad_file_blocked(ctx: Ctx): Promise<void> {
  expectRows(ctx, [joined(ctx, "A1"), joined(ctx, "A2"), blocked(ctx, "A1"), readRow(ctx, "A2")]);
  const roomId = await roomWithBoth(ctx);
  const created = await upload(ctx, roomId, "A1", fileBody(NOTES_FILE, ctx.pack.notesWithPatient));
  if (created.outcome !== "held") fail(`${NOTES_FILE} outcome was ${created.outcome}`);
  if (created.block?.category !== BlockCategory.Name || created.block.location !== BlockLocation.FileBody) {
    fail(`block was ${created.block?.category ?? "missing"}/${created.block?.location ?? "missing"}`);
  }
  const items = await feed(ctx, roomId, "A2");
  if (items.some((item) => item.kind === "file" && item.name === NOTES_FILE)) fail("A2 saw the blocked file");
}

export async function test_P3_health_number_and_dob_blocked(ctx: Ctx): Promise<void> {
  const health = new RegExp(HEALTH_NUMBER_PATTERN).exec(ctx.pack.notesWithPatient)?.[0];
  if (!health) fail("fixture notes have no health number");
  const dobLine = ctx.pack.notesWithPatient
    .split(/\r?\n/)
    .find((line) => DOB_CUES.some((cue) => line.toLowerCase().includes(cue)));
  if (!dobLine) fail("fixture notes have no date-of-birth cue");
  expectRows(ctx, [joined(ctx, "A1"), joined(ctx, "A2"), blocked(ctx, "A1"), blocked(ctx, "A1")]);
  const roomId = await roomWithBoth(ctx);
  const healthPost = await postMessage(ctx, roomId, "A1", health);
  const dobPost = await postMessage(ctx, roomId, "A1", dobLine);
  if (healthPost.outcome !== "held" || healthPost.block?.category !== BlockCategory.HealthNumber) {
    fail(`health number outcome ${healthPost.outcome} category ${healthPost.block?.category ?? "missing"}`);
  }
  if (dobPost.outcome !== "held" || dobPost.block?.category !== BlockCategory.Dob) {
    fail(`date of birth outcome ${dobPost.outcome} category ${dobPost.block?.category ?? "missing"}`);
  }
}

export async function test_P4_no_false_positives(ctx: Ctx): Promise<void> {
  if (ctx.pack.normalMessages.length !== 20) fail(`fixture has ${ctx.pack.normalMessages.length} normal messages`);
  expectRows(ctx, [joined(ctx, "A1"), uploaded(ctx, "A1"), ...ctx.pack.normalMessages.map(() => posted(ctx, "A1"))]);
  const roomId = await createRoom(ctx, "O1");
  await addMember(ctx, roomId, "O1", "A1");
  let blocks = 0;
  const file = await upload(ctx, roomId, "A1", fileBody(TREE_FILE, ctx.pack.tree));
  if (file.outcome !== "accepted") blocks += 1;
  for (const text of ctx.pack.normalMessages) {
    const created = await postMessage(ctx, roomId, "A1", text);
    if (created.outcome !== "accepted") blocks += 1;
  }
  ctx.metrics.p4BlockCount = blocks;
  if (blocks !== 0) fail(`block count ${blocks}`);
}

export async function test_P5_name_in_filename_or_metadata(ctx: Ctx): Promise<void> {
  const name = ctx.pack.names[0];
  if (!name) fail("name list is empty");
  const hiddenFile = `${name.toLowerCase().replaceAll(" ", "-")}.md`;
  expectRows(ctx, [joined(ctx, "A1"), joined(ctx, "A2"), blocked(ctx, "A1"), blocked(ctx, "A1"), readRow(ctx, "A2")]);
  const roomId = await roomWithBoth(ctx);
  const byName = await upload(ctx, roomId, "A1", fileBody(hiddenFile, ctx.pack.tree));
  const byMeta = await upload(ctx, roomId, "A1", fileBody("clean.md", ctx.pack.tree, { title: name }));
  if (byName.outcome !== "held" || byName.block?.location !== BlockLocation.FileName) {
    fail(`file name outcome ${byName.outcome} location ${byName.block?.location ?? "missing"}`);
  }
  if (byMeta.outcome !== "held" || byMeta.block?.location !== BlockLocation.FileMeta) {
    fail(`file details outcome ${byMeta.outcome} location ${byMeta.block?.location ?? "missing"}`);
  }
  if (byName.block?.category !== BlockCategory.Name || byMeta.block?.category !== BlockCategory.Name) {
    fail("a hidden name was not categorised as a name");
  }
  const items = await feed(ctx, roomId, "A2");
  if (items.length !== 0) fail("A2 saw a held file");
}

export async function test_L1_every_action_logged(ctx: Ctx): Promise<void> {
  const problems: { kind: FailureKind; message: string }[] = [];
  let entries: AuditRecord[] | undefined;
  try {
    entries = await readEveryOwner(ctx);
    if (!l1Matches(ctx.expected, entries)) {
      const deadline = Date.now() + W1_LIMIT_MS;
      while (Date.now() < deadline && !l1Matches(ctx.expected, entries)) {
        await delay(100);
        entries = await readEveryOwner(ctx);
      }
    }
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: thrownMessage(error) });
  }
  if (entries && !l1Matches(ctx.expected, entries)) {
    problems.push({ kind: "assertion", message: describeMismatch(ctx.expected, entries) });
  }
  try {
    const verified = audit.verify();
    ctx.metrics.auditVerify = verified;
    if (!verified.ok) problems.push({ kind: "assertion", message: `audit.verify() ${JSON.stringify(verified)}` });
  } catch (error) {
    ctx.metrics.auditVerify = thrownMessage(error);
    problems.push({ kind: classifyThrown(error), message: `audit.verify() threw: ${thrownMessage(error)}` });
  }
  if (entries) ctx.evidence.L1 = entries.map((entry) => entry.id);
  if (problems.length > 0) combine(problems);
}

export async function test_L2_edit_or_delete_refused(ctx: Ctx): Promise<void> {
  const problems: { kind: FailureKind; message: string }[] = [];
  const db = openDatabase(ctx.dbPath);
  let seededId = "";
  let updateRefused = false;
  let deleteRefused = false;
  try {
    seededId = seedAuditRow(db);
    updateRefused = changeRefused(db, "UPDATE audit_log SET result = 'refused' WHERE id = ?", seededId);
    deleteRefused = changeRefused(db, "DELETE FROM audit_log WHERE id = ?", seededId);
    if (!updateRefused) problems.push({ kind: "assertion", message: "UPDATE was not refused" });
    if (!deleteRefused) problems.push({ kind: "assertion", message: "DELETE was not refused" });
    db.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
    const current = db.prepare("SELECT hash FROM audit_log WHERE id = ?").get(seededId) as { hash: string };
    const tampered = current.hash.startsWith("ab") ? "cd".repeat(32) : "ab".repeat(32);
    db.prepare("UPDATE audit_log SET hash = ? WHERE id = ?").run(tampered, seededId);
  } catch (error) {
    problems.push({ kind: classifyThrown(error), message: thrownMessage(error) });
  } finally {
    db.close();
  }
  const preface = `update refused: ${updateRefused}; delete refused: ${deleteRefused}`;
  try {
    const verified = audit.verify();
    ctx.metrics.auditVerify = verified;
    if (verified.ok) problems.push({ kind: "assertion", message: "audit.verify() did not report the tampered entry" });
  } catch (error) {
    ctx.metrics.auditVerify = thrownMessage(error);
    problems.push({ kind: classifyThrown(error), message: `audit.verify() threw: ${thrownMessage(error)}` });
  } finally {
    const restore = openDatabase(ctx.dbPath);
    restore.close();
  }
  if (problems.length > 0) {
    const kind = problems.some((problem) => problem.kind === "assertion") ? "assertion" : "not-built";
    throw new AcceptanceFailure([preface, ...problems.map((problem) => problem.message)].join("\n"), kind);
  }
}

export async function test_L3_owner_sees_only_own(ctx: Ctx): Promise<void> {
  const roomId = await roomWithBoth(ctx);
  const fromA1 = await postMessage(ctx, roomId, "A1", ordinary(ctx, 13));
  const fromA2 = await postMessage(ctx, roomId, "A2", ordinary(ctx, 14));
  if (fromA1.outcome !== "accepted" || fromA2.outcome !== "accepted") fail("could not store an entry for A1 and A2");
  const own = await logFor(ctx, "O2", ownerToken(ctx, "O2"));
  const theirs = await logFor(ctx, "O1", ownerToken(ctx, "O1"));
  if (!theirs.some((row) => row.agentId === "A1")) fail("no log entry for A1");
  if (!own.some((row) => row.agentId === "A2")) fail("O2 does not see A2");
  for (const row of own) {
    if (row.ownerId !== "O2") fail(`O2 sees owner ${row.ownerId}`);
    if (row.agentId !== "A2" && row.agentId !== ownerActorId("O2")) fail(`O2 sees agent ${row.agentId}`);
  }
  const refused = await request(ctx, "GET", "/log?owner=O1", ownerToken(ctx, "O2"));
  if (refused.status !== 403) fail(`O2 asking for owner=O1 returned ${refused.status}: ${refused.text}`);
  const after = await logFor(ctx, "O2", ownerToken(ctx, "O2"));
  const refusal = after.find(
    (row) => row.action === AuditAction.Read && row.result === AuditResult.Refused && row.room === UNSCOPED_ROOM,
  );
  if (!refusal) fail("the refusal was not logged");
  if (refusal.agentId !== ownerActorId("O2") || refusal.ownerId !== "O2") {
    fail(`refusal logged as ${refusal.agentId}/${refusal.ownerId}`);
  }
  if (refusal.detail.reasonCode !== ReasonCode.LogOwnerMismatch) {
    fail(`refusal reason was ${refusal.detail.reasonCode ?? "missing"}`);
  }
}

async function readEveryOwner(ctx: Ctx): Promise<AuditRecord[]> {
  const entries: AuditRecord[] = [];
  for (const owner of ctx.pack.owners) {
    entries.push(...(await logFor(ctx, owner.id, ownerToken(ctx, owner.id))));
  }
  return entries;
}

function describeMismatch(expected: readonly ExpectedLogRow[], actual: readonly AuditRecord[]): string {
  const expectedCounts = new Map<string, number>();
  for (const row of expected) expectedCounts.set(l1Key(row), (expectedCounts.get(l1Key(row)) ?? 0) + 1);
  const actualCounts = new Map<string, number>();
  for (const row of actual) actualCounts.set(l1Key(row), (actualCounts.get(l1Key(row)) ?? 0) + 1);
  const lines = [`expected ${expected.length} log rows, got ${actual.length}`];
  const keys = [...new Set([...expectedCounts.keys(), ...actualCounts.keys()])].sort();
  for (const key of keys) {
    const want = expectedCounts.get(key) ?? 0;
    const got = actualCounts.get(key) ?? 0;
    if (want !== got) lines.push(`${key.replaceAll("\0", " | ")}: expected ${want}, got ${got}`);
  }
  if (lines.length === 1) {
    lines.push("row keys match but a timestamp is missing or not YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  return lines.join("\n");
}

function sharingLevel(ctx: Ctx, roomId: string, fromOwnerId: string, toOwnerId: string): string | null {
  const db = openDatabase(ctx.dbPath);
  try {
    const row = db
      .prepare("SELECT level FROM sharing WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?")
      .get(roomId, fromOwnerId, toOwnerId) as { level: string } | undefined;
    return row?.level ?? null;
  } finally {
    db.close();
  }
}

function sharingPairs(ctx: Ctx, roomId: string): { fromOwnerId: string; toOwnerId: string; level: string }[] {
  const db = openDatabase(ctx.dbPath);
  try {
    return db
      .prepare("SELECT from_owner_id AS fromOwnerId, to_owner_id AS toOwnerId, level FROM sharing WHERE room_id = ?")
      .all(roomId) as { fromOwnerId: string; toOwnerId: string; level: string }[];
  } finally {
    db.close();
  }
}

function changeRefused(db: ReturnType<typeof openDatabase>, sql: string, id: string): boolean {
  try {
    db.prepare(sql).run(id);
    return false;
  } catch (error) {
    if (!/append-only/i.test(thrownMessage(error))) throw error;
    return true;
  }
}

function seedAuditRow(db: ReturnType<typeof openDatabase>): string {
  const last = db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
    | { seq: number; hash: string }
    | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const sealed = sealAuditRecord(last?.hash ?? GENESIS_PREV_HASH, {
    id: `log_l2_${seq}`,
    seq,
    ts: "2026-01-02T03:04:05.006Z",
    room: UNSCOPED_ROOM,
    agentId: "A1",
    ownerId: "O1",
    action: AuditAction.Post,
    result: AuditResult.Ok,
    detail: {},
  });
  db.prepare(
    `INSERT INTO audit_log (seq, id, ts, room, agent_id, owner_id, action, result, detail_json, prev_hash, hash)
     VALUES (@seq, @id, @ts, @room, @agentId, @ownerId, @action, @result, @detail, @prevHash, @hash)`,
  ).run({
    seq: sealed.seq,
    id: sealed.id,
    ts: sealed.ts,
    room: sealed.room,
    agentId: sealed.agentId,
    ownerId: sealed.ownerId,
    action: sealed.action,
    result: sealed.result,
    detail: "{}",
    prevHash: sealed.prevHash,
    hash: sealed.hash,
  });
  return sealed.id;
}

export const CASES: Record<AcceptanceTestId, (ctx: Ctx) => Promise<void>> = {
  R1: test_R1_a1_posts_a2_reads,
  R2: test_R2_non_member_refused_and_logged,
  R3: test_R3_ten_posts_logged_with_owner,
  W1: test_W1_wake_within_60s_10_of_10,
  W2: test_W2_down_retries_then_email_logged,
  W3: test_W3_no_self_wake_and_loop,
  S1: test_S1_none_a2_sees_nothing,
  S2: test_S2_messages_hides_files,
  S3: test_S3_messages_files_both,
  S4: test_S4_a2_cannot_change_o1_setting,
  S5: test_S5_new_room_defaults_none,
  P1: test_P1_name_in_message_blocked,
  P2: test_P2_bad_file_blocked,
  P3: test_P3_health_number_and_dob_blocked,
  P4: test_P4_no_false_positives,
  P5: test_P5_name_in_filename_or_metadata,
  L1: test_L1_every_action_logged,
  L2: test_L2_edit_or_delete_refused,
  L3: test_L3_owner_sees_only_own,
};
