import { afterEach, describe, expect, it } from "vitest";
import { SharingLevel } from "../../contract/index.js";
import { agentCookieName } from "../../src/room-page/routes.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const HTML_POST = "Grok Bot: bring forks";
const JSON_POST = "OpenAI Dots: bring plates";
const LATER_POST = "Meta Muse: bring cups";
const FILE_NAME = "plates.txt";
const FILE_BYTES = "plate-photo";

describe("open-join default post sharing", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("shares posts both ways, leaves files hidden, and lets the owner narrow afterward", async () => {
    room = await startJoinHarness();
    expect(room.sharing.level(room.roomId, "O1", "O2")).toBe(SharingLevel.None);

    const html = await joinHtml(room);
    const htmlOwner = ownerOf(room, html.agentId);
    await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}`,
      form: { nonce: html.nonce, text: HTML_POST },
    });

    const dots = await joinJson(room);
    const dotsOwner = ownerOf(room, dots.agentId);
    expect(dots.posts.map((post) => post.text)).toContain(HTML_POST);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, dotsOwner, htmlOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", "O2")).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, htmlOwner, "O1")).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", htmlOwner)).toBe(SharingLevel.Messages);

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
    const dotsRead = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: dots.agentKey });
    const dotsPosts = (JSON.parse(dotsRead.body) as { posts: { text: string }[] }).posts.map((post) => post.text);
    expect(dotsPosts).toContain(HTML_POST);
    expect(dotsPosts).toContain(JSON_POST);

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
    expect(ownFile.body).toContain(Buffer.from(FILE_BYTES).toString("base64"));
    const dotsFeed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: dots.agentKey });
    expect(dotsFeed.status).toBe(200);
    expect(dotsFeed.body).toContain(HTML_POST);
    expect(dotsFeed.body.includes(FILE_NAME)).toBe(false);
    expect(dotsFeed.body.includes(FILE_BYTES)).toBe(false);

    const agentChange = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
      token: html.key,
      json: { fromOwnerId: htmlOwner, toOwnerId: dotsOwner, level: "none" },
    });
    expect(agentChange.status).toBe(403);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.Messages);

    const ownerToken = room.tokens.issueOwnerToken(htmlOwner);
    const narrowed = await call(room.baseUrl, "PUT", `/rooms/${room.roomId}/sharing`, {
      token: ownerToken,
      json: { fromOwnerId: htmlOwner, toOwnerId: dotsOwner, level: "none" },
    });
    expect(narrowed.status).toBe(200);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, dotsOwner, htmlOwner)).toBe(SharingLevel.Messages);

    const after = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: dots.agentKey });
    const afterPosts = (JSON.parse(after.body) as { posts: { text: string }[] }).posts.map((post) => post.text);
    expect(afterPosts).not.toContain(HTML_POST);
    expect(afterPosts).toContain(JSON_POST);
    const stillOwn = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${html.key}`,
    });
    expect(stillOwn.body).toContain(HTML_POST);
    const stillHidden = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/${fileId}`, {
      token: dots.agentKey,
    });
    expect(stillHidden.status).toBe(404);
    expect(stillHidden.body.includes(FILE_BYTES)).toBe(false);

    const muse = await joinJson(room);
    const museOwner = ownerOf(room, muse.agentId);
    expect(room.sharing.level(room.roomId, htmlOwner, dotsOwner)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, htmlOwner, museOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, museOwner, htmlOwner)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", "O2")).toBe(SharingLevel.None);
    expect(muse.posts.map((post) => post.text)).toContain(HTML_POST);
    expect(muse.posts.map((post) => post.text)).toContain(JSON_POST);
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
    const dotsAfterMuse = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: dots.agentKey });
    const dotsAfterPosts = (JSON.parse(dotsAfterMuse.body) as { posts: { text: string }[] }).posts.map(
      (post) => post.text,
    );
    expect(dotsAfterPosts).toContain(LATER_POST);
    expect(dotsAfterPosts).not.toContain(HTML_POST);
  });
});

async function joinHtml(room: JoinHarness): Promise<{ key: string; nonce: string; agentId: string }> {
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
  return { key, nonce, agentId: principal.agentId };
}

async function joinJson(room: JoinHarness): Promise<{ agentKey: string; agentId: string; posts: { text: string }[] }> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?t=${secret}`);
  expect(opened.status).toBe(200);
  return JSON.parse(opened.body) as { agentKey: string; agentId: string; posts: { text: string }[] };
}

function ownerOf(room: JoinHarness, agentId: string): string {
  const row = room.db.prepare("SELECT owner_id FROM agents WHERE id = ?").get(agentId) as { owner_id: string };
  return row.owner_id;
}
