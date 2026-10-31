import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/index.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { BRIEF_TEXT_MAX } from "../../src/room/brief.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

const origin = "https://join.example.test";
const hostSecret = "host-test-secret";
const title = "Sunday lunch";
const hostName = "Host (demo)";

function manualClock(start = "2026-04-01T12:00:00.000Z"): { now(): Date; advance(ms: number): void } {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advance(by: number) {
      ms += by;
    },
  };
}

function deadline(clock: { now(): Date }, days: number, extraMs = 0): string {
  return new Date(clock.now().getTime() + days * 24 * 60 * 60 * 1000 + extraMs).toISOString();
}

describe("room brief", () => {
  const previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
  const previousSecret = process.env.COMMONA_HOST_SECRET;

  afterEach(() => {
    if (previousOrigin === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previousOrigin;
    if (previousSecret === undefined) delete process.env.COMMONA_HOST_SECRET;
    else process.env.COMMONA_HOST_SECRET = previousSecret;
  });

  it("stores a short future brief, returns it on join, read, the page, and the feed, and ignores an agent key", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    process.env.COMMONA_HOST_SECRET = hostSecret;
    const clock = manualClock();
    const db = openDatabase(":memory:");
    const tokens = createTokenStore(db);
    const audit = createAuditLog(db, clock);
    const app = buildApp({ db, clock, tokens, audit, sharing: createSharingDirectory(db) });
    const brief = {
      task: "Agree a pretend lunch time and place",
      endCondition: "Every member has agreed the same time and place",
      deadline: deadline(clock, 7),
    };
    try {
      const roomsBefore = count(db, "SELECT COUNT(*) AS n FROM rooms");
      for (const bad of badBriefs(clock)) {
        const refused = await postRoom(app, { title, hostName, inviteCount: 1, brief: bad });
        expect(refused.status).toBe(400);
        expect(count(db, "SELECT COUNT(*) AS n FROM rooms")).toBe(roomsBefore);
      }

      const edge = await postRoom(app, {
        title,
        hostName,
        inviteCount: 1,
        brief: { ...brief, deadline: deadline(clock, 30) },
      });
      expect(edge.status).toBe(201);
      await edge.text();

      const created = await postRoom(app, { title, hostName, inviteCount: 2, brief });
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        invites: string[];
        credential: string;
        roomId: string;
        ownerToken: string;
        ownerId: string;
        agentId: string;
      };
      expect(count(db, "SELECT COUNT(*) AS n FROM posts WHERE room_id = ?", body.roomId)).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS n FROM agent_post_hits")).toBe(0);

      const link = new URL(body.invites[0] ?? "");
      const joined = await app.fetch(new Request(`${origin}/api${link.pathname}`));
      expect(joined.status).toBe(200);
      const joinBody = (await joined.json()) as { brief: typeof brief; guide: string; posts: unknown[] };
      expect(joinBody.brief).toEqual(brief);
      expect(joinBody.guide).toContain("commona-agent/1.0");
      expect(joinBody.posts).toEqual([]);

      const read = await app.fetch(
        new Request(`${origin}/api/r/${body.roomId}`, {
          headers: { authorization: `Bearer ${body.credential}` },
        }),
      );
      expect(read.status).toBe(200);
      const readBody = (await read.json()) as { brief: typeof brief; posts: unknown[] };
      expect(readBody.brief).toEqual(brief);
      expect(readBody.posts).toEqual([]);

      const pageLink = new URL(body.invites[1] ?? "");
      const parts = pageLink.pathname.split("/");
      const opened = await app.fetch(new Request(`${origin}/r/${body.roomId}/${parts[2]}/${parts[3]}`));
      expect(opened.status).toBe(303);
      const cookie = opened.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const page = await app.fetch(new Request(`${origin}/r/${body.roomId}`, { headers: { cookie } }));
      const html = await page.text();
      expect(html.indexOf("<h2>Room brief</h2>")).toBeGreaterThan(html.indexOf("<h1>"));
      expect(html.indexOf(brief.task)).toBeLessThan(html.indexOf("No posts yet."));
      expect(html).toContain(`Done when: ${brief.endCondition}`);
      expect(html).not.toContain("<blockquote>");

      const feed = await app.fetch(
        new Request(`${origin}/rooms/${body.roomId}/feed`, {
          headers: { authorization: `Bearer ${body.credential}` },
        }),
      );
      expect(feed.status).toBe(200);
      const feedBody = (await feed.json()) as { brief: typeof brief; items: { text?: string }[] };
      expect(feedBody.brief).toEqual(brief);
      expect(feedBody.items).toEqual([]);

      const posted = await app.fetch(
        new Request(`${origin}/api/r/${body.roomId}`, {
          method: "POST",
          headers: { authorization: `Bearer ${body.credential}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "Tuesday afternoon is free" }),
        }),
      );
      expect(posted.status).toBe(201);
      expect(count(db, "SELECT COUNT(*) AS n FROM posts WHERE room_id = ?", body.roomId)).toBe(1);
      expect(count(db, "SELECT COUNT(*) AS n FROM agent_post_hits")).toBe(1);
      const texts = db.prepare("SELECT text FROM posts WHERE room_id = ?").all(body.roomId) as { text: string }[];
      expect(texts).toEqual([{ text: "Tuesday afternoon is free" }]);

      const agentDenied = await putBrief(app, body.roomId, body.credential, {
        ...brief,
        task: "An agent must not rewrite the brief",
      });
      expect(agentDenied.status).toBe(403);
      const refused = db
        .prepare("SELECT action, result FROM audit_log WHERE action = 'setting_change_refused' AND room = ?")
        .get(body.roomId) as { action: string; result: string };
      expect(refused).toEqual({ action: "setting_change_refused", result: "refused" });
      expect(readStored(db, body.roomId)?.task).toBe(brief.task);

      db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES (?, ?, ?, ?)").run(
        "owner_00000000-0000-4000-8000-000000000099",
        "other@example.test",
        "Other Owner",
        "participant",
      );
      const other = tokens.issueOwnerToken("owner_00000000-0000-4000-8000-000000000099");
      const otherDenied = await putBrief(app, body.roomId, other, brief);
      expect(otherDenied.status).toBe(403);

      const next = { ...brief, task: "Agree a pretend dinner instead", deadline: deadline(clock, 3) };
      const saved = await putBrief(app, body.roomId, body.ownerToken, next);
      expect(saved.status).toBe(200);
      expect(readStored(db, body.roomId)).toEqual(next);
      const reread = await app.fetch(
        new Request(`${origin}/api/r/${body.roomId}`, {
          headers: { authorization: `Bearer ${body.credential}` },
        }),
      );
      expect(((await reread.json()) as { brief: typeof next }).brief).toEqual(next);
      expect(body.ownerId.length).toBeGreaterThan(0);
      expect(body.agentId.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      db.close();
    }
  });
});

function badBriefs(clock: { now(): Date }): unknown[] {
  const good = {
    task: "Agree a pretend lunch",
    endCondition: "Both agents agree",
    deadline: deadline(clock, 1),
  };
  return [
    { ...good, task: "" },
    { ...good, task: "a".repeat(BRIEF_TEXT_MAX + 1) },
    { ...good, endCondition: "line one\nline two" },
    { ...good, deadline: deadline(clock, 0) },
    { ...good, deadline: deadline(clock, -1) },
    { ...good, deadline: deadline(clock, 30, 1) },
    { ...good, deadline: "next week" },
    { task: good.task, deadline: good.deadline },
    null,
  ];
}

function count(db: ReturnType<typeof openDatabase>, sql: string, arg?: string): number {
  const row = (arg === undefined ? db.prepare(sql).get() : db.prepare(sql).get(arg)) as { n: number };
  return Number(row.n);
}

function readStored(
  db: ReturnType<typeof openDatabase>,
  roomId: string,
): { task: string; endCondition: string; deadline: string } | null {
  const row = db.prepare("SELECT task, end_condition, deadline FROM room_briefs WHERE room_id = ?").get(roomId) as
    | { task: string; end_condition: string; deadline: string }
    | undefined;
  if (!row) return null;
  return { task: row.task, endCondition: row.end_condition, deadline: row.deadline };
}

function postRoom(app: ReturnType<typeof buildApp>, payload: unknown): Promise<Response> {
  return app.fetch(
    new Request(`${origin}/host/room`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOST_SECRET_HEADER]: hostSecret },
      body: JSON.stringify(payload),
    }),
  );
}

function putBrief(app: ReturnType<typeof buildApp>, roomId: string, token: string, payload: unknown): Promise<Response> {
  return app.fetch(
    new Request(`${origin}/api/r/${roomId}/brief`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}
