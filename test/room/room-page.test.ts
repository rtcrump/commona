import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { RECENT_MESSAGE_LIMIT, RECENT_MESSAGE_MAX_BATCHES, RECENT_MESSAGES_SQL } from "../../src/room-page/messages.js";
import { POSTS_RECENT_INDEX } from "../../src/room-page/schema.js";
import { agentCookieName } from "../../src/room-page/routes.js";
import { TASK_CLOSE } from "../../src/task-close.js";
import { call, cookieValue, createInvite, startJoinHarness, type Hit, type JoinHarness } from "../onboarding/harness.js";

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
    expect(opened.status).toBe(303);
    expect(opened.location).toBe(`/r/${room.roomId}`);
    expect(opened.body.includes(secret)).toBe(false);
    expect(opened.body.includes(hashToken(secret))).toBe(false);
    const cookieName = agentCookieName(room.roomId);
    const key = cookieValue(opened.setCookies, cookieName);
    const header = opened.setCookies.find((value) => value.startsWith(`${cookieName}=`)) ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain(`Path=/r/${room.roomId}`);
    expect(/^[A-Za-z0-9_-]{20,}$/.test(key)).toBe(true);
    expect(opened.body.includes(key)).toBe(false);
    expect(memberCount(room)).toBe(membersBefore + 1);
    expect(auditText(room).includes(secret)).toBe(false);
    expect(auditText(room).includes(key)).toBe(false);

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${agentCookieName(room.roomId)}=${key}` });
    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(page.body).toContain("<h1>Sunday lunch</h1>");
    expect(page.body).toContain("No posts yet.");
    expect(page.body.includes("Host note about napkins")).toBe(false);
    expect(page.body).toContain('<form method="post"');
    expect(page.body).toContain('name="text"');
    expect(page.body).toContain(">Post</button>");
    expect(page.body).toContain(`POST /rooms/${room.roomId}/posts is live`);
    expect(page.body).toContain(`GET /rooms/${room.roomId}/feed is live`);
    expect(TASK_CLOSE).toBe(
      "Report the result to your own owner. Say what was agreed, with whom, and anything still open.",
    );
    expect(page.body).toContain(`<p id="task-close">${TASK_CLOSE}</p>`);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body.includes(`<pre>${key}</pre>`)).toBe(true);
    expect(page.body.includes(secret)).toBe(false);
    expect(flashCount(room)).toBe(0);

    const again = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${key}`,
    });
    expect(again.status).toBe(200);
    expect(again.body).toContain(`<p id="task-close">${TASK_CLOSE}</p>`);
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
    const cookieName = agentCookieName(room.roomId);
    expect(head.setCookies.some((value) => value.startsWith(`${cookieName}=`))).toBe(false);
    expect(head.body.includes(secret)).toBe(false);
    const pending = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id) as {
      used_at: string | null;
    };
    expect(pending.used_at).toBeNull();

    const opened = await call(room.baseUrl, "GET", path);
    expect(opened.status).toBe(303);
    expect(opened.location).toBe(`/r/${room.roomId}`);
    const key = cookieValue(opened.setCookies, agentCookieName(room.roomId));
    expect(/^[A-Za-z0-9_-]{20,}$/.test(key)).toBe(true);
    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${agentCookieName(room.roomId)}=${key}` });
    expect(page.status).toBe(200);
    expect(page.body.includes(`<pre>${key}</pre>`)).toBe(true);
    expect(page.body.includes(secret)).toBe(false);
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
    const cookieName = agentCookieName(room.roomId);
    expect(opened.setCookies.some((value) => value.startsWith(`${cookieName}=`))).toBe(false);
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
    const joined = await joinRoom(room, `/r/${room.roomId}/${invite.id}/${secret}`);
    const key = joined.key;
    const nonce = nonceOf(joined.page.body);
    const stored = room.db.prepare("SELECT token_hash FROM room_form_tokens").get() as { token_hash: string };
    expect(stored.token_hash).toBe(hashToken(nonce));
    expect(stored.token_hash).not.toBe(nonce);

    const posted = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${key}`,
      form: { nonce, text: MARKUP },
    });
    expect(posted.status).toBe(303);
    expect(posted.location).toBe(`/r/${room.roomId}`);
    expect(posted.body.includes(secret)).toBe(false);
    expect(posted.body.includes(key)).toBe(false);

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${key}`,
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
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secret}`);
    const key = joined.key;
    const postsBefore = postCount(room);

    const badToken = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${key}`,
      form: { nonce: "not-the-token", text: "Bring napkins" },
    });
    expect(badToken.status).toBe(403);
    expect(postCount(room)).toBe(postsBefore);

    const noCookie = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      form: { nonce: nonceOf(joined.page.body), text: "Bring napkins" },
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
    expect(stillGood.status).toBe(303);
    expect(stillGood.location).toBe(`/r/${room.roomId}`);
    expect(cookieValue(stillGood.setCookies, agentCookieName(room.roomId)).length).toBeGreaterThan(20);
  });

  it("shows the room when a used invite URL is opened with that room's agent cookie", async () => {
    room = await startJoinHarness();
    nameRoom(room, "Sunday lunch");
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const path = `/r/${room.roomId}/${invite.id}/${secret}`;
    const joined = await joinRoom(room, path);
    expect(joined.page.body.includes(`<pre>${joined.key}</pre>`)).toBe(true);

    const again = await call(room.baseUrl, "GET", path, { cookie: `${agentCookieName(room.roomId)}=${joined.key}` });
    expect(again.status).toBe(200);
    expect(again.body).toContain("<h1>Sunday lunch</h1>");
    expect(again.body).toContain('<form method="post"');
    expect(again.body).not.toContain("This invite cannot be used");
    expect(again.body.includes(joined.key)).toBe(false);
    expect(again.body.includes(secret)).toBe(false);
  });

  it("shows only the 20 newest messages and does not read file content", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secretOf(invite.openPath)}`);
    const member = room.db
      .prepare("SELECT agent_id, owner_id FROM memberships WHERE room_id = ? AND agent_id NOT IN ('A1', 'A2')")
      .get(room.roomId) as { agent_id: string; owner_id: string };
    for (let index = 1; index <= 21; index += 1) {
      const stamp = `2026-04-02T00:00:${String(index).padStart(2, "0")}.000Z`;
      const id = `post_room_page_${String(index).padStart(2, "0")}`;
      room.db
        .prepare(
          `INSERT INTO posts (
             id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
             block_category, block_location, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
        )
        .run(id, room.roomId, member.agent_id, member.owner_id, `Napkin note ${String(index).padStart(2, "0")}`, id, stamp);
    }
    const fileBytes = Buffer.from("FILEBYTES-ROOM-PAGE");
    room.db
      .prepare(
        `INSERT INTO files (
           id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
           byte_length, round, held, block_category, block_location, created_at
         ) VALUES (?, ?, ?, ?, 'napkin-list.txt', 'text/plain', ?, '{}', ?, 1, 0, NULL, NULL, ?)`,
      )
      .run("file_room_page_blob", room.roomId, member.agent_id, member.owner_id, fileBytes, fileBytes.length, "2026-04-02T00:01:00.000Z");

    const seen: string[] = [];
    const prepare = room.db.prepare.bind(room.db);
    room.db.prepare = ((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof room.db.prepare;
    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${agentCookieName(room.roomId)}=${joined.key}` });
    room.db.prepare = prepare;
    expect(page.status).toBe(200);
    expect(page.body).toContain("Napkin note 02");
    expect(page.body).toContain("Napkin note 21");
    expect(page.body.includes("Napkin note 01")).toBe(false);
    expect(page.body.includes("FILEBYTES-ROOM-PAGE")).toBe(false);
    expect(page.body.includes("napkin-list.txt")).toBe(false);
    expect(page.body.indexOf("Napkin note 02")).toBeLessThan(page.body.indexOf("Napkin note 21"));
    expect(seen.some((sql) => sql.includes("LIMIT"))).toBe(true);
    expect(seen.some((sql) => sql.includes("FROM files") || sql.includes("from files"))).toBe(false);
    expect(RECENT_MESSAGES_SQL.includes("FROM files")).toBe(false);
    expect(RECENT_MESSAGES_SQL.includes("content")).toBe(false);
  });

  it("keeps a separate agent cookie for each room", async () => {
    room = await startJoinHarness();
    nameRoom(room, "Sunday lunch");
    const first = await createInvite(room);
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secretOf(first.openPath)}`);
    const firstName = agentCookieName(room.roomId);

    const created = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, json: {} });
    const otherId = (JSON.parse(created.body) as { room: { id: string } }).room.id;
    await call(room.baseUrl, "POST", `/rooms/${otherId}/members`, { token: room.owner, json: { agentId: "A1" } });
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(otherId, "Monday lunch");
    const minted = await call(room.baseUrl, "POST", `/rooms/${otherId}/invites`, { token: room.owner, json: {} });
    const link = (JSON.parse(minted.body) as { invite: { link: string } }).invite.link;
    const secondSecret = new URL(link).pathname.split("/")[3] ?? "";
    const otherOpened = await call(room.baseUrl, "GET", `/r/${otherId}?t=${secondSecret}`);
    expect(otherOpened.status).toBe(303);
    expect(otherOpened.location).toBe(`/r/${otherId}`);
    const otherName = agentCookieName(otherId);
    const otherKey = cookieValue(otherOpened.setCookies, otherName);
    const otherHeader = otherOpened.setCookies.find((value) => value.startsWith(`${otherName}=`)) ?? "";
    expect(otherName).not.toBe(firstName);
    expect(otherHeader).toContain(`Path=/r/${otherId}`);
    expect(/^[A-Za-z0-9_-]{20,}$/.test(otherKey)).toBe(true);

    const both = `${firstName}=${joined.key}; ${otherName}=${otherKey}`;
    const firstPage = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: both });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toContain("<h1>Sunday lunch</h1>");
    expect(firstPage.body.includes(otherKey)).toBe(false);

    const secondPage = await call(room.baseUrl, "GET", `/r/${otherId}`, { cookie: both });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body).toContain("<h1>Monday lunch</h1>");
    expect(secondPage.body.includes(`<pre>${otherKey}</pre>`)).toBe(true);
    expect(secondPage.body.includes(joined.key)).toBe(false);

    const onlyOther = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${otherName}=${otherKey}` });
    expect(onlyOther.status).toBe(403);
  });

  it("shows the newest 20 messages the viewer can see, past newer hidden ones", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secretOf(invite.openPath)}`);
    const member = room.db
      .prepare("SELECT agent_id, owner_id FROM memberships WHERE room_id = ? AND agent_id NOT IN ('A1', 'A2')")
      .get(room.roomId) as { agent_id: string; owner_id: string };
    for (let index = 1; index <= 21; index += 1) {
      const stamp = `2026-04-03T00:00:${String(index).padStart(2, "0")}.000Z`;
      const id = `post_visible_${String(index).padStart(2, "0")}`;
      room.db
        .prepare(
          `INSERT INTO posts (
             id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
             block_category, block_location, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
        )
        .run(id, room.roomId, member.agent_id, member.owner_id, `Visible note ${String(index).padStart(2, "0")}`, id, stamp);
    }
    for (let index = 1; index <= 25; index += 1) {
      const stamp = `2026-04-03T01:00:${String(index).padStart(2, "0")}.000Z`;
      const id = `post_hidden_${String(index).padStart(2, "0")}`;
      room.db
        .prepare(
          `INSERT INTO posts (
             id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
             block_category, block_location, created_at
           ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
        )
        .run(id, room.roomId, `Hidden note ${String(index).padStart(2, "0")}`, id, stamp);
    }

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${joined.key}`,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Visible note 02");
    expect(page.body).toContain("Visible note 21");
    expect(page.body.includes("Visible note 01")).toBe(false);
    expect(page.body.includes("Hidden note")).toBe(false);
    expect(page.body.indexOf("Visible note 02")).toBeLessThan(page.body.indexOf("Visible note 21"));
  });

  it("keeps visible notes in order when hidden notes sit between them", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secretOf(invite.openPath)}`);
    const member = room.db
      .prepare("SELECT agent_id, owner_id FROM memberships WHERE room_id = ? AND agent_id NOT IN ('A1', 'A2')")
      .get(room.roomId) as { agent_id: string; owner_id: string };
    const roomId = room.roomId;
    let tick = 0;
    const insert = room.db.prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    );
    const write = room.db.transaction(() => {
      for (let index = 1; index <= 21; index += 1) {
        const label = String(index).padStart(2, "0");
        tick += 1;
        insert.run(
          `post_gap_visible_${label}`,
          roomId,
          member.agent_id,
          member.owner_id,
          `Gap note ${label}`,
          `post_gap_visible_${label}`,
          stampAt(tick),
        );
        for (let hidden = 1; hidden <= 4; hidden += 1) {
          tick += 1;
          const id = `post_gap_hidden_${label}_${hidden}`;
          insert.run(id, roomId, "A1", "O1", `Hidden gap ${label}`, id, stampAt(tick));
        }
      }
    });
    write();

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${joined.key}`,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Gap note 02");
    expect(page.body).toContain("Gap note 21");
    expect(page.body.includes("Gap note 01")).toBe(false);
    expect(page.body.includes("Hidden gap")).toBe(false);
    expect(page.body.indexOf("Gap note 02")).toBeLessThan(page.body.indexOf("Gap note 21"));
  });

  it("stops after the scan cap when newer posts are hidden", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const joined = await joinRoom(room, `/r/${room.roomId}?t=${secretOf(invite.openPath)}`);
    const columns = room.db.prepare(`PRAGMA index_info(${POSTS_RECENT_INDEX})`).all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(["room_id", "held", "created_at", "id"]);
    const plan = room.db.prepare(`EXPLAIN QUERY PLAN ${RECENT_MESSAGES_SQL}`).all(room.roomId, "9", "9", 20) as {
      detail: string;
    }[];
    expect(plan.some((row) => row.detail.includes(POSTS_RECENT_INDEX))).toBe(true);

    const member = room.db
      .prepare("SELECT agent_id, owner_id FROM memberships WHERE room_id = ? AND agent_id NOT IN ('A1', 'A2')")
      .get(room.roomId) as { agent_id: string; owner_id: string };
    const roomId = room.roomId;
    const hiddenRows = RECENT_MESSAGE_LIMIT * RECENT_MESSAGE_MAX_BATCHES;
    const insert = room.db.prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    );
    const write = room.db.transaction(() => {
      insert.run(
        "post_past_cap",
        roomId,
        member.agent_id,
        member.owner_id,
        "Visible note past the cap",
        "post_past_cap",
        stampAt(1),
      );
      for (let index = 1; index <= hiddenRows; index += 1) {
        const id = `post_cap_hidden_${String(index).padStart(3, "0")}`;
        insert.run(id, roomId, "A1", "O1", `Hidden cap ${String(index).padStart(3, "0")}`, id, stampAt(index + 1));
      }
    });
    write();

    let batches = 0;
    const prepare = room.db.prepare.bind(room.db);
    room.db.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (sql === RECENT_MESSAGES_SQL) {
        const all = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          batches += 1;
          return all(...args);
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof room.db.prepare;
    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${joined.key}`,
    });
    room.db.prepare = prepare;

    expect(page.status).toBe(200);
    expect(page.body).toContain("No posts yet.");
    expect(page.body.includes("Visible note past the cap")).toBe(false);
    expect(page.body.includes("Hidden cap")).toBe(false);
    expect(batches).toBe(RECENT_MESSAGE_MAX_BATCHES);
  });
});

function stampAt(index: number): string {
  const minute = Math.floor(index / 60);
  const second = index % 60;
  return `2026-04-06T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

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

async function joinRoom(room: JoinHarness, path: string): Promise<{ key: string; page: Hit }> {
  const opened = await call(room.baseUrl, "GET", path);
  expect(opened.status).toBe(303);
  expect(opened.location).toBe(`/r/${room.roomId}`);
  const key = cookieValue(opened.setCookies, agentCookieName(room.roomId));
  const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${agentCookieName(room.roomId)}=${key}` });
  expect(page.status).toBe(200);
  return { key, page };
}

function flashCount(room: JoinHarness): number {
  const row = room.db.prepare("SELECT COUNT(*) AS n FROM room_key_flash").get() as { n: number };
  return row.n;
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
