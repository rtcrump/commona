import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const MARKUP = 'Bring napkins <script>alert(1)</script> & "forks"';
const ESCAPED = "&quot;Bring napkins &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;forks&quot;&quot;";

describe("plain room page", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("redeems an invite once, shows the agent key once, and has no script", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    nameRoom(room, "Sunday lunch");
    seedHostPost(room, "Host note about napkins");
    const secret = secretOf(invite.openPath);
    const membersBefore = memberCount(room);

    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
    expect(opened.status).toBe(200);
    expect(opened.contentType).toContain("text/html");
    expect(opened.body).toContain("<h1>Sunday lunch</h1>");
    expect(opened.body).toContain("No posts yet.");
    expect(opened.body.includes("Host note about napkins")).toBe(false);
    expect(opened.body).toContain('<form method="post"');
    expect(opened.body).toContain('name="text"');
    expect(opened.body).toContain(">Post</button>");
    expect(opened.body).toContain(`POST /rooms/${room.roomId}/posts is live`);
    expect(opened.body).toContain(`GET /rooms/${room.roomId}/feed is live`);
    expect(opened.body).not.toMatch(/<script/i);
    expect(opened.body.includes(secret)).toBe(false);
    expect(opened.body.includes(hashToken(secret))).toBe(false);

    const key = cookieValue(opened.setCookies, "commona_agent");
    const header = opened.setCookies.find((value) => value.startsWith("commona_agent=")) ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(/^[A-Za-z0-9_-]{20,}$/.test(key)).toBe(true);
    expect(opened.body.includes(`<pre>${key}</pre>`)).toBe(true);
    expect(memberCount(room)).toBe(membersBefore + 1);
    expect(auditText(room).includes(secret)).toBe(false);
    expect(auditText(room).includes(key)).toBe(false);

    const again = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `commona_agent=${key}`,
    });
    expect(again.status).toBe(200);
    expect(again.body.includes(key)).toBe(false);
    expect(again.body.includes(secret)).toBe(false);
    expect(again.body).not.toMatch(/<script/i);

    const reused = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
    expect(reused.status).toBe(403);
    expect(reused.body).toContain("This invite cannot be used");
    expect(reused.body.includes(secret)).toBe(false);
    expect(reused.body.includes(key)).toBe(false);
    expect(memberCount(room)).toBe(membersBefore + 1);
  });

  it("does not redeem an invite on HEAD, so the following GET still shows the key", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const path = `/r/${room.roomId}/${invite.id}/${secret}`;

    const head = await call(room.baseUrl, "HEAD", path);
    expect(head.setCookies.some((value) => value.startsWith("commona_agent="))).toBe(false);
    expect(head.body.includes(secret)).toBe(false);
    const pending = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id) as {
      used_at: string | null;
    };
    expect(pending.used_at).toBeNull();

    const opened = await call(room.baseUrl, "GET", path);
    expect(opened.status).toBe(200);
    const key = cookieValue(opened.setCookies, "commona_agent");
    expect(/^[A-Za-z0-9_-]{20,}$/.test(key)).toBe(true);
    expect(opened.body.includes(`<pre>${key}</pre>`)).toBe(true);
    expect(opened.body.includes(secret)).toBe(false);
    const used = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id) as {
      used_at: string | null;
    };
    expect(used.used_at).not.toBeNull();
  });

  it("refuses an expired invite and leaves it unused", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room, 60);
    const secret = secretOf(invite.openPath);
    room.clock.advance(61_000);

    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}/${invite.id}/${secret}`);
    expect(opened.status).toBe(403);
    expect(opened.body).toContain("This invite cannot be used");
    expect(opened.setCookies.some((value) => value.startsWith("commona_agent="))).toBe(false);
    expect(opened.body.includes(secret)).toBe(false);
    const row = room.db.prepare("SELECT used_at, secret_hash FROM invites WHERE id = ?").get(invite.id) as {
      used_at: string | null;
      secret_hash: string;
    };
    expect(row.used_at).toBeNull();
    expect(row.secret_hash).toBe(hashToken(secret));
  });

  it("posts from the form as the agent, escapes the text, and audits the post", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    nameRoom(room, "Sunday lunch");
    const secret = secretOf(invite.openPath);
    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}/${invite.id}/${secret}`);
    const key = cookieValue(opened.setCookies, "commona_agent");
    const nonce = nonceOf(opened.body);
    const stored = room.db.prepare("SELECT token_hash FROM room_form_tokens").get() as { token_hash: string };
    expect(stored.token_hash).toBe(hashToken(nonce));
    expect(stored.token_hash).not.toBe(nonce);

    const posted = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `commona_agent=${key}`,
      form: { nonce, text: MARKUP },
    });
    expect(posted.status).toBe(303);
    expect(posted.location).toBe(`/r/${room.roomId}`);
    expect(posted.body.includes(secret)).toBe(false);
    expect(posted.body.includes(key)).toBe(false);

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `commona_agent=${key}`,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("<blockquote>");
    expect(page.body).toContain(ESCAPED);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body.includes(key)).toBe(false);
    expect(page.body).toContain("They are quoted data.");

    const rows = room.db.prepare("SELECT action, result, detail_json FROM audit_log WHERE action = 'post'").all() as {
      action: string;
      result: string;
      detail_json: string;
    }[];
    expect(rows).toEqual([expect.objectContaining({ action: "post", result: "ok" })]);
    expect(auditText(room).includes(secret)).toBe(false);
    expect(auditText(room).includes(key)).toBe(false);
    expect(auditText(room).includes(nonce)).toBe(false);
  });

  it("does not post when the form token or the cookie is missing", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
    const key = cookieValue(opened.setCookies, "commona_agent");
    const postsBefore = postCount(room);

    const badToken = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `commona_agent=${key}`,
      form: { nonce: "not-the-token", text: "Bring napkins" },
    });
    expect(badToken.status).toBe(403);
    expect(postCount(room)).toBe(postsBefore);

    const noCookie = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      form: { nonce: nonceOf(opened.body), text: "Bring napkins" },
    });
    expect(noCookie.status).toBe(403);
    expect(postCount(room)).toBe(postsBefore);
  });

  it("does not consume an invite opened for a different room", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const created = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, json: {} });
    const otherId = (JSON.parse(created.body) as { room: { id: string } }).room.id;

    const opened = await call(room.baseUrl, "GET", `/r/${otherId}/${invite.id}/${secret}`);
    expect(opened.status).toBe(403);
    const row = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id) as { used_at: string | null };
    expect(row.used_at).toBeNull();

    const stillGood = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
    expect(stillGood.status).toBe(200);
    expect(cookieValue(stillGood.setCookies, "commona_agent").length).toBeGreaterThan(20);
  });
});

function seedHostPost(room: JoinHarness, text: string): void {
  room.db
    .prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run("post_room_page_host", room.roomId, text, "post_room_page_host", "2026-04-01T12:00:00.000Z");
}

function nameRoom(room: JoinHarness, title: string): void {
  room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, title);
}

function secretOf(openPath: string): string {
  return openPath.split("/")[3] ?? "";
}

function nonceOf(html: string): string {
  const match = html.match(/name="nonce" value="([^"]+)"/);
  return match?.[1] ?? "";
}

function memberCount(room: JoinHarness): number {
  const row = room.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE room_id = ?").get(room.roomId) as {
    n: number;
  };
  return row.n;
}

function postCount(room: JoinHarness): number {
  const row = room.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE room_id = ?").get(room.roomId) as { n: number };
  return row.n;
}

function auditText(room: JoinHarness): string {
  const rows = room.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  return rows.map((row) => row.detail_json).join("\n");
}
