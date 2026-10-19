import { afterEach, describe, expect, it } from "vitest";
import { hashToken, SharingLevel } from "../../contract/index.js";
import { setInviteLog } from "../../src/join/log.js";
import { ROOM_DEFAULT_POLICY_OWNER } from "../../src/sharing/room-default-share.js";
import { agentCookieName, ownerCookieName } from "../../src/room-page/routes.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const HTML_POST = "Grok Bot: bring forks";
const JSON_POST = "OpenAI Dots: bring plates";
const LATER_POST = "Meta Muse: bring cups";
const OWNER_POST = "Host note about napkins";
const FILE_NAME = "plates.txt";
const FILE_BYTES = "plate-photo";

describe("open-join default post sharing", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("shares an invite joiner's posts, and not another member's, until that owner narrows", async () => {
    room = await startJoinHarness();
    seedOwnerPost(room, OWNER_POST);
    expect(room.sharing.level(room.roomId, "O1", "O2")).toBe(SharingLevel.None);

    const html = await joinHtml(room);
    const htmlOwner = ownerOf(room, html.agentId);
    expect(html.page.includes(OWNER_POST)).toBe(false);
    expect(room.sharing.level(room.roomId, htmlOwner, "O1")).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", htmlOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, "O2", htmlOwner)).toBe(SharingLevel.None);

    await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}`,
      form: { nonce: html.nonce, text: HTML_POST },
    });
    const replayed = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}; ${ownerCookieName(room.roomId)}=${html.ownerToken}`,
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body.includes(html.ownerToken)).toBe(false);
    const ownerAgent = room.tokens.issueAgentToken("A1");
    const ownerFeed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: ownerAgent });
    expect(ownerFeed.status).toBe(200);
    expect(ownerFeed.body).toContain(HTML_POST);
    expect(ownerFeed.body).toContain(OWNER_POST);

    const dots = await joinJson(room);
    const dotsOwner = ownerOf(room, dots.agentId);
    expect(dots.posts.map((post) => post.text)).toContain(HTML_POST);
    expect(dots.posts.map((post) => post.text)).not.toContain(OWNER_POST);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, dotsOwner, htmlOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", dotsOwner)).toBe(SharingLevel.None);
    expect(policyGrants(room).every((row) => row.ownerId === ROOM_DEFAULT_POLICY_OWNER)).toBe(true);
    expect(policyGrants(room).some((row) => row.agentId !== `owner:${ROOM_DEFAULT_POLICY_OWNER}`)).toBe(false);
    expect(
      policyGrants(room).some(
        (row) => row.itemId === dots.inviteId && row.fromOwnerId === htmlOwner && row.toOwnerId === dotsOwner,
      ),
    ).toBe(true);
    expect(policyGrants(room).some((row) => row.fromOwnerId === "O1" || row.fromOwnerId === "O2")).toBe(false);

    const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: dots.agentKey,
      json: { text: JSON_POST },
    });
    expect(posted.status).toBe(201);
    const htmlPage = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}`,
    });
    expect(htmlPage.body).toContain(HTML_POST);
    expect(htmlPage.body).toContain(JSON_POST);
    expect(htmlPage.body.includes(OWNER_POST)).toBe(false);

    const uploaded = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/files`, {
      token: html.key,
      json: {
        filename: FILE_NAME,
        mediaType: "text/plain",
        contentBase64: Buffer.from(FILE_BYTES).toString("base64"),
      },
    });
    expect(uploaded.status).toBe(201);
    const fileId = (JSON.parse(uploaded.body) as { file: { id: string } }).file.id;
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.Messages);
    const hiddenFile = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/${fileId}`, {
      token: dots.agentKey,
    });
    expect(hiddenFile.status).toBe(404);
    expect(hiddenFile.body.includes(FILE_BYTES)).toBe(false);
    const ownFile = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/${fileId}`, { token: html.key });
    expect(ownFile.status).toBe(200);
    const dotsFeed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: dots.agentKey });
    expect(dotsFeed.body).toContain(HTML_POST);
    expect(dotsFeed.body.includes(FILE_NAME)).toBe(false);
    expect(dotsFeed.body.includes(FILE_BYTES)).toBe(false);
    expect(dotsFeed.body.includes(OWNER_POST)).toBe(false);

    const agentChange = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
      token: html.key,
      json: { fromOwnerId: htmlOwner, toOwnerId: dotsOwner, level: "none" },
    });
    expect(agentChange.status).toBe(403);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.Messages);
    expect(stillOnDefault(room, htmlOwner)).toBe(true);

    const issuedBeforeNarrow = room.issued.length;
    const narrowed = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
      token: html.ownerToken,
      json: { fromOwnerId: htmlOwner, toOwnerId: dotsOwner, level: "none" },
    });
    expect(narrowed.status).toBe(200);
    expect(room.issued.length).toBe(issuedBeforeNarrow);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, dotsOwner, htmlOwner)).toBe(SharingLevel.Messages);
    expect(stillOnDefault(room, htmlOwner)).toBe(false);
    const narrowedAudit = JSON.parse(narrowed.body) as { sharing: { fromOwnerId: string } };
    expect(narrowedAudit.sharing.fromOwnerId).toBe(htmlOwner);

    const after = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: dots.agentKey });
    const afterPosts = (JSON.parse(after.body) as { posts: { text: string }[] }).posts.map((post) => post.text);
    expect(afterPosts).not.toContain(HTML_POST);
    expect(afterPosts).toContain(JSON_POST);
    const stillHidden = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/${fileId}`, {
      token: dots.agentKey,
    });
    expect(stillHidden.status).toBe(404);

    const muse = await joinJson(room);
    const museOwner = ownerOf(room, muse.agentId);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, htmlOwner, museOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, museOwner, htmlOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, dotsOwner, museOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", "O2")).toBe(SharingLevel.None);
    expect(muse.posts.map((post) => post.text)).not.toContain(HTML_POST);
    expect(muse.posts.map((post) => post.text)).not.toContain(OWNER_POST);
    expect(muse.posts.map((post) => post.text)).toContain(JSON_POST);
    expect(
      policyGrants(room).some((row) => row.itemId === muse.inviteId && row.fromOwnerId === htmlOwner),
    ).toBe(false);
    expect(
      policyGrants(room).filter((row) => row.itemId === muse.inviteId).every((row) => row.ownerId === ROOM_DEFAULT_POLICY_OWNER),
    ).toBe(true);

    const museFile = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/${fileId}`, {
      token: muse.agentKey,
    });
    expect(museFile.status).toBe(404);
    expect(museFile.body.includes(FILE_BYTES)).toBe(false);
    const musePosted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: muse.agentKey,
      json: { text: LATER_POST },
    });
    expect(musePosted.status).toBe(201);
    const htmlAfter = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}`,
    });
    expect(htmlAfter.body).toContain(LATER_POST);
    expect(htmlAfter.body).toContain(HTML_POST);
    expect(htmlAfter.body.includes(html.ownerToken)).toBe(false);
    const htmlOwnerRow = room.db.prepare("SELECT token_hash FROM owners WHERE id = ?").get(htmlOwner) as {
      token_hash: string;
    };
    expect(htmlOwnerRow.token_hash).toBe(hashToken(html.ownerToken));
    expect(storedText(room).includes(html.ownerToken)).toBe(false);
    expect(storedText(room).includes(dots.ownerToken)).toBe(false);
  });

  it("narrows sharing with the owner token the json join returned", async () => {
    room = await startJoinHarness();
    const lines: string[] = [];
    setInviteLog((line) => {
      lines.push(line);
    });
    try {
      const first = await joinJson(room);
      const second = await joinJson(room);
      expect(first.ownerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(first.ownerId).toMatch(/^owner_/);
      expect(second.ownerId).not.toBe(first.ownerId);

      const denied = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
        token: first.agentKey,
        json: { fromOwnerId: first.ownerId, toOwnerId: second.ownerId, level: "none" },
      });
      expect(denied.status).toBe(403);
      expect(room.sharing.level(room.roomId, first.ownerId, second.ownerId)).toBe(SharingLevel.Messages);

      const issuedBeforeNarrow = room.issued.length;
      const narrowed = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
        token: first.ownerToken,
        json: { fromOwnerId: first.ownerId, toOwnerId: second.ownerId, level: "none" },
      });
      expect(narrowed.status).toBe(200);
      expect(room.issued.length).toBe(issuedBeforeNarrow);
      expect(room.sharing.level(room.roomId, first.ownerId, second.ownerId)).toBe(SharingLevel.None);
      expect(stillOnDefault(room, first.ownerId)).toBe(false);

      const stored = room.db.prepare("SELECT token_hash FROM owners WHERE id = ?").get(first.ownerId) as {
        token_hash: string;
      };
      expect(stored.token_hash).toBe(hashToken(first.ownerToken));
      expect(stored.token_hash.includes(first.ownerToken)).toBe(false);
      expect(storedText(room).includes(first.ownerToken)).toBe(false);
      expect(storedText(room).includes(second.ownerToken)).toBe(false);
      const audit = room.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
      expect(JSON.stringify(audit).includes(first.ownerToken)).toBe(false);
      expect(lines.join("\n").includes(first.ownerToken)).toBe(false);
      expect(lines.join("\n").includes(second.ownerToken)).toBe(false);

      const again = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: first.agentKey });
      expect(again.status).toBe(200);
      expect(again.body.includes(first.ownerToken)).toBe(false);
      expect(again.body.includes(first.agentKey)).toBe(false);
    } finally {
      setInviteLog(() => {});
    }
  });
});

function seedOwnerPost(room: JoinHarness, text: string): void {
  room.db
    .prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run("post_owner_created", room.roomId, text, "post_owner_created", "2026-04-01T12:00:00.000Z");
}

async function joinHtml(room: JoinHarness): Promise<{
  key: string;
  nonce: string;
  agentId: string;
  ownerId: string;
  ownerToken: string;
  page: string;
  inviteId: string;
}> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
  expect(opened.status).toBe(303);
  const key = cookieValue(opened.setCookies, agentCookieName(room.roomId));
  const ownerToken = cookieValue(opened.setCookies, ownerCookieName(room.roomId));
  expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
    cookie: `${agentCookieName(room.roomId)}=${key}; ${ownerCookieName(room.roomId)}=${ownerToken}`,
  });
  expect(page.status).toBe(200);
  expect(page.body).toContain(`<pre>${ownerToken}</pre>`);
  expect(page.setCookies.some((value) => value.startsWith(`${ownerCookieName(room.roomId)}=`) && value.includes("Max-Age=0"))).toBe(
    true,
  );
  const nonce = page.body.match(/name="nonce" value="([^"]+)"/)?.[1] ?? "";
  const ownerId = page.body.match(/Owner id: ([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const principal = room.tokens.authenticate(key);
  if (!principal || principal.kind !== "agent") throw new Error("missing agent");
  expect(ownerId).toBe(principal.ownerId);
  return { key, nonce, agentId: principal.agentId, ownerId, ownerToken, page: page.body, inviteId: invite.id };
}

async function joinJson(room: JoinHarness): Promise<{
  agentKey: string;
  agentId: string;
  ownerId: string;
  ownerToken: string;
  posts: { text: string }[];
  inviteId: string;
}> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?t=${secret}`);
  expect(opened.status).toBe(200);
  const body = JSON.parse(opened.body) as {
    agentKey: string;
    agentId: string;
    ownerId: string;
    ownerToken: string;
    posts: { text: string }[];
  };
  expect(body.ownerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(opened.body.includes(hashToken(body.ownerToken))).toBe(false);
  return { ...body, inviteId: invite.id };
}

function storedText(room: JoinHarness): string {
  const names = room.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return names
    .filter((table) => /^[A-Za-z0-9_]+$/.test(table.name))
    .map((table) => JSON.stringify(room.db.prepare(`SELECT * FROM "${table.name}"`).all()))
    .join("\n");
}

function ownerOf(room: JoinHarness, agentId: string): string {
  const row = room.db.prepare("SELECT owner_id FROM agents WHERE id = ?").get(agentId) as { owner_id: string };
  return row.owner_id;
}

function stillOnDefault(room: JoinHarness, ownerId: string): boolean {
  const row = room.db
    .prepare("SELECT owner_id FROM room_default_post_share WHERE room_id = ? AND owner_id = ?")
    .get(room.roomId, ownerId) as { owner_id: string } | undefined;
  return row !== undefined;
}

function policyGrants(room: JoinHarness): {
  agentId: string;
  ownerId: string;
  fromOwnerId: string;
  toOwnerId: string;
  itemId: string;
}[] {
  const rows = room.db
    .prepare("SELECT agent_id, owner_id, detail_json FROM audit_log WHERE action = 'setting_change'")
    .all() as { agent_id: string; owner_id: string; detail_json: string }[];
  return rows.flatMap((row) => {
    const detail = JSON.parse(row.detail_json) as {
      level?: string;
      fromOwnerId?: string;
      toOwnerId?: string;
      itemId?: string;
    };
    if (detail.level !== "messages") return [];
    return [
      {
        agentId: row.agent_id,
        ownerId: row.owner_id,
        fromOwnerId: detail.fromOwnerId ?? "",
        toOwnerId: detail.toOwnerId ?? "",
        itemId: detail.itemId ?? "",
      },
    ];
  });
}
