import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rememberBriefPostCap } from "../../src/agent-api/limit.js";
import { NEWER_MESSAGES_SQL, SINCE_START } from "../../src/room-page/messages.js";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const FREE = "Tuesday noon is free";
const PARK = "The park is free at noon";
const HIDDEN = "Raw calendar: dentist Tuesday 13:00";
const HOST_NOTE = "Host note about napkins";

describe("wait for news, house rules, and the task cap", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("returns only visible posts newer than the cursor, plus a next cursor", async () => {
    room = await startJoinHarness();
    seedHostPost(room, HOST_NOTE);
    const reader = await join(room);
    const author = await join(room);
    const first = await postLine(room, author.agentKey, FREE);
    const second = await postLine(room, author.agentKey, PARK);

    const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${SINCE_START}`, {
      token: reader.agentKey,
    });
    expect(opened.status).toBe(200);
    const page = JSON.parse(opened.body) as SinceBody;
    expect(page.posts).toEqual([
      { id: first, text: FREE },
      { id: second, text: PARK },
    ]);
    expect(page.cursor).toBe(second);
    expect(opened.body.includes(HOST_NOTE)).toBe(false);

    const newer = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${first}`, {
      token: reader.agentKey,
    });
    expect(newer.status).toBe(200);
    expect(JSON.parse(newer.body)).toMatchObject({
      posts: [{ id: second, text: PARK }],
      cursor: second,
    });
    expect(newer.body.includes(FREE)).toBe(false);

    const caughtUp = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${second}`, {
      token: reader.agentKey,
    });
    expect(JSON.parse(caughtUp.body)).toMatchObject({ posts: [], cursor: second });
    expect(NEWER_MESSAGES_SQL.includes("files")).toBe(false);
    expect(NEWER_MESSAGES_SQL.includes("content")).toBe(false);
  });

  it("reads since a cursor with no wait, for an agent that checks in on a schedule", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const id = await postLine(room, joined.agentKey, FREE);
    const started = Date.now();
    const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${SINCE_START}`, {
      token: joined.agentKey,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ posts: [{ id, text: FREE }], cursor: id });
    expect(read.body.includes("wait")).toBe(false);
  });

  it("holds until a visible post arrives, and a hidden post does not end the wait or leak", async () => {
    room = await startJoinHarness();
    const reader = await join(room);
    const author = await join(room);
    const seen = await postLine(room, author.agentKey, FREE);
    const cursor = (
      JSON.parse(
        (
          await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${SINCE_START}`, {
            token: reader.agentKey,
          })
        ).body,
      ) as SinceBody
    ).cursor;
    expect(cursor).toBe(seen);

    const started = Date.now();
    const pending = fetch(`${room.baseUrl}/api/r/${room.roomId}?since=${cursor}&wait=25`, {
      headers: { authorization: `Bearer ${reader.agentKey}` },
    });
    await delay(50);
    const arrived = await postLine(room, author.agentKey, PARK);
    const waited = await pending;
    const waitedText = await waited.text();
    expect(waited.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(JSON.parse(waitedText)).toMatchObject({
      posts: [{ id: arrived, text: PARK }],
      cursor: arrived,
    });

    const narrowed = await call(room.baseUrl, "PUT", `/api/rooms/${room.roomId}/sharing`, {
      token: author.sharingKey,
      json: { fromOwnerId: author.ownerId, toOwnerId: reader.ownerId, level: "none" },
    });
    expect(narrowed.status).toBe(200);
    const hiddenStart = Date.now();
    const hiddenWait = fetch(`${room.baseUrl}/api/r/${room.roomId}?since=${arrived}&wait=1`, {
      headers: { authorization: `Bearer ${reader.agentKey}` },
    });
    await delay(50);
    const hiddenId = await postLine(room, author.agentKey, HIDDEN);
    const hiddenResponse = await hiddenWait;
    const hiddenBody = await hiddenResponse.text();
    expect(hiddenResponse.status).toBe(200);
    expect(Date.now() - hiddenStart).toBeGreaterThanOrEqual(700);
    expect(JSON.parse(hiddenBody)).toMatchObject({ posts: [], cursor: arrived });
    expect(hiddenBody.includes(HIDDEN)).toBe(false);
    expect(hiddenBody.includes(hiddenId)).toBe(false);

    const again = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=${arrived}`, {
      token: reader.agentKey,
    });
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ posts: [], cursor: arrived });
    expect(again.body.includes(HIDDEN)).toBe(false);
  }, 15_000);

  it("returns house rules on join, including the brief and the calendar limit", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    expect(joined.rules).toEqual([
      "Post only when there is something new.",
      "Answer every proposal.",
      "Report to your owner when the task is done or stalled.",
      "You can post at most 12 times in this room for this task.",
      "Work from the brief.",
      "Post only free times and place preferences, never raw calendar entries.",
    ]);
    const text = joined.rules.join("\n");
    expect(text).toContain("Work from the brief.");
    expect(text).toContain("Post only free times and place preferences, never raw calendar entries.");

    rememberBriefPostCap(room.db, room.roomId, 4);
    const again = await join(room);
    expect(again.rules.join("\n")).toContain("at most 4 times");
    expect(again.rules.join("\n")).toContain("Work from the brief.");
    expect(again.rules.join("\n")).toContain("Post only free times and place preferences, never raw calendar entries.");
  });

  it("returns 429 at the task cap, uses the brief's cap, and still applies the hourly cap", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const other = await join(room);
    for (let index = 0; index < 12; index += 1) {
      const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
        token: joined.agentKey,
        json: { text: `Bring napkins ${index}` },
      });
      expect(posted.status).toBe(201);
    }
    const limited = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: joined.agentKey,
      json: { text: "Bring napkins again" },
    });
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBeNull();
    expect(JSON.parse(limited.body)).toEqual({
      error: {
        code: "validation",
        message: "This task allows 12 posts in this room. That limit has been reached.",
      },
    });
    const stored = room.db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE room_id = ? AND author_agent_id = ?")
      .get(room.roomId, joined.agentId) as { n: number };
    expect(Number(stored.n)).toBe(12);
    const hits = room.db
      .prepare("SELECT COUNT(*) AS n FROM agent_post_hits WHERE agent_id = ?")
      .get(joined.agentId) as { n: number };
    expect(Number(hits.n)).toBe(12);
    const refused = room.db
      .prepare(
        "SELECT action, result, detail_json FROM audit_log WHERE agent_id = ? AND action = 'post' AND result = 'refused'",
      )
      .all(joined.agentId) as { action: string; result: string; detail_json: string }[];
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]?.detail_json).toContain("429");

    const otherPost = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: other.agentKey,
      json: { text: PARK },
    });
    expect(otherPost.status).toBe(201);

    const ownerToken = room.tokens.issueOwnerToken(joined.ownerId);
    const created = await call(room.baseUrl, "POST", "/rooms", { token: ownerToken, json: {} });
    const otherRoom = (JSON.parse(created.body) as { room: { id: string } }).room.id;
    const added = await call(room.baseUrl, "POST", `/rooms/${otherRoom}/members`, {
      token: ownerToken,
      json: { agentId: joined.agentId },
    });
    expect(added.status).toBe(201);
    const elsewhere = await call(room.baseUrl, "POST", `/api/r/${otherRoom}`, {
      token: joined.agentKey,
      json: { text: FREE },
    });
    expect(elsewhere.status).toBe(201);

    rememberBriefPostCap(room.db, otherRoom, 2);
    const second = await call(room.baseUrl, "POST", `/api/r/${otherRoom}`, {
      token: joined.agentKey,
      json: { text: PARK },
    });
    expect(second.status).toBe(201);
    const briefLimited = await call(room.baseUrl, "POST", `/api/r/${otherRoom}`, {
      token: joined.agentKey,
      json: { text: "Bring forks" },
    });
    expect(briefLimited.status).toBe(429);
    expect(JSON.parse(briefLimited.body)).toEqual({
      error: {
        code: "validation",
        message: "This task allows 2 posts in this room. That limit has been reached.",
      },
    });

  });

  it("still applies the 30-an-hour cap when the brief allows more", async () => {
    room = await startJoinHarness();
    rememberBriefPostCap(room.db, room.roomId, 40);
    const joined = await join(room);
    for (let index = 0; index < 30; index += 1) {
      const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
        token: joined.agentKey,
        json: { text: `Bring napkins ${index}` },
      });
      expect(posted.status).toBe(201);
    }
    const hourly = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: joined.agentKey,
      json: { text: "Bring napkins late" },
    });
    expect(hourly.status).toBe(429);
    expect(hourly.retryAfter).toBe("3600");
    expect(JSON.parse(hourly.body)).toEqual({ error: { code: "validation", message: "Try again later." } });
  });

  it("returns 400 for a bad cursor or a bad wait, and does not hold the call", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const id = await postLine(room, joined.agentKey, FREE);
    const created = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, json: {} });
    const otherId = (JSON.parse(created.body) as { room: { id: string } }).room.id;
    await call(room.baseUrl, "POST", `/rooms/${otherId}/members`, { token: room.owner, json: { agentId: "A1" } });
    const hostKey = room.tokens.issueAgentToken("A1");
    room.clock.advance(1000);
    const elsewhere = await call(room.baseUrl, "POST", `/api/r/${otherId}`, {
      token: hostKey,
      json: { text: "Bring forks" },
    });
    expect(elsewhere.status).toBe(201);
    const otherPost = (JSON.parse(elsewhere.body) as { post: { id: string } }).post.id;

    for (const since of ["nope", "bad cursor", "", otherPost]) {
      const response = await call(
        room.baseUrl,
        "GET",
        `/api/r/${room.roomId}?since=${encodeURIComponent(since)}`,
        { token: joined.agentKey },
      );
      expect(response.status).toBe(400);
      expect(response.body).toContain("That cursor is not valid.");
    }

    const started = Date.now();
    const held = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?since=nope&wait=1`, {
      token: joined.agentKey,
    });
    expect(held.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(500);

    for (const wait of ["0", "26", "1.5", "-1", "01"]) {
      const response = await call(
        room.baseUrl,
        "GET",
        `/api/r/${room.roomId}?since=${id}&wait=${encodeURIComponent(wait)}`,
        { token: joined.agentKey },
      );
      expect(response.status).toBe(400);
      expect(response.body).toContain("Wait must be a whole number of seconds from 1 to 25.");
    }
    const missing = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?wait=1`, { token: joined.agentKey });
    expect(missing.status).toBe(400);
    expect(missing.body).toContain("A wait needs a since cursor.");
  });

  it("does not branch on the client name", () => {
    const root = fileURLToPath(new URL("../../src/", import.meta.url));
    const hits = filesUnder(root).filter((path) => /user-agent/i.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });
});

interface Joined {
  agentId: string;
  ownerId: string;
  agentKey: string;
  sharingKey: string;
  rules: string[];
}

interface SinceBody {
  posts: { id: string; text: string }[];
  cursor: string;
}

async function join(room: JoinHarness): Promise<Joined> {
  const invite = await createInvite(room);
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secretOf(invite.openPath)}`);
  expect(opened.status).toBe(200);
  return JSON.parse(opened.body) as Joined;
}

async function postLine(room: JoinHarness, key: string, text: string): Promise<string> {
  room.clock.advance(1000);
  const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
    token: key,
    json: { text },
  });
  expect(posted.status).toBe(201);
  return (JSON.parse(posted.body) as { post: { id: string } }).post.id;
}

function seedHostPost(room: JoinHarness, text: string): void {
  room.db
    .prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run("post_wait_host", room.roomId, text, "post_wait_host", "2026-04-01T11:00:00.000Z");
}

function secretOf(openPath: string): string {
  return openPath.split("/")[3] ?? "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = joinPath(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}
