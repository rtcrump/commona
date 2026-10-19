import { afterEach, describe, expect, it } from "vitest";
import { SharingLevel } from "../../contract/index.js";
import { ROOM_DEFAULT_POLICY_OWNER } from "../../src/onboarding/room-default-share.js";
import { agentCookieName } from "../../src/room-page/routes.js";
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

    const ownerToken = room.tokens.issueOwnerToken(htmlOwner);
    const narrowed = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
      token: ownerToken,
      json: { fromOwnerId: htmlOwner, toOwnerId: dotsOwner, level: "none" },
    });
    expect(narrowed.status).toBe(200);
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

async function joinHtml(
  room: JoinHarness,
): Promise<{ key: string; nonce: string; agentId: string; page: string; inviteId: string }> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
  expect(opened.status).toBe(303);
  const key = cookieValue(opened.setCookies, agentCookieName(room.roomId));
  const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
    cookie: `${agentCookieName(room.roomId)}=${key}`,
  });
  expect(page.status).toBe(200);
  const nonce = page.body.match(/name="nonce" value="([^"]+)"/)?.[1] ?? "";
  const principal = room.tokens.authenticate(key);
  if (!principal || principal.kind !== "agent") throw new Error("missing agent");
  return { key, nonce, agentId: principal.agentId, page: page.body, inviteId: invite.id };
}

async function joinJson(
  room: JoinHarness,
): Promise<{ agentKey: string; agentId: string; posts: { text: string }[]; inviteId: string }> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?t=${secret}`);
  expect(opened.status).toBe(200);
  const body = JSON.parse(opened.body) as { agentKey: string; agentId: string; posts: { text: string }[] };
  return { ...body, inviteId: invite.id };
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
