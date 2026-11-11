import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { NEW_AGENT_NAME, NEW_OWNER_NAME } from "../../src/onboarding/account.js";
import { agentCookieName } from "../../src/room-page/routes.js";

const hostSecret = "host-test-secret";

/** Fake vendors. Not people, and not patient data. */
const GROK_NOTE = "Grok Bot: bring forks";
const DOTS_NOTE = "OpenAI Dots: bring plates";
const MUSE_NOTE = "Meta Muse: bring cups";

describe("open-join acceptance", () => {
  it("G1 GET /health returns ok on the Worker", async () => {
    const response = await SELF.fetch("https://room.example.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "commona" });
  });

  it("G2 three vendor agents join once and each sees the others' posts", async () => {
    const room = await hostRoom("Sunday lunch", 3);
    const [htmlInvite, dotsInvite, museInvite] = room.invites;
    if (!htmlInvite || !dotsInvite || !museInvite) throw new Error("room:new did not mint three invites");

    const grok = await joinHtml(room.roomId, htmlInvite);
    await postForm(room.roomId, grok, GROK_NOTE);

    const dots = await joinJson(room.roomId, dotsInvite);
    await postJson(room.roomId, dots.agentKey, DOTS_NOTE);

    const muse = await joinJson(room.roomId, museInvite);
    await postJson(room.roomId, muse.agentKey, MUSE_NOTE);

    const notes = [GROK_NOTE, DOTS_NOTE, MUSE_NOTE];
    const grokPage = await readHtml(room.roomId, grok.cookie);
    for (const note of notes) expect(grokPage).toContain(note);
    expect(grokPage).not.toMatch(/<script/i);

    const dotsPosts = await readJson(room.roomId, dots.agentKey);
    const musePosts = await readJson(room.roomId, muse.agentKey);
    const owners = await ownerIdsForAgents(room.roomId, [grok.agentId, dots.agentId, muse.agentId]);
    expect(new Set(owners).size).toBe(3);
    expect(owners.every((ownerId) => ownerId.length > 0)).toBe(true);
    const writtenBy = [
      { text: GROK_NOTE, agentId: grok.agentId, ownerId: owners[0] ?? "" },
      { text: DOTS_NOTE, agentId: dots.agentId, ownerId: owners[1] ?? "" },
      { text: MUSE_NOTE, agentId: muse.agentId, ownerId: owners[2] ?? "" },
    ];
    for (const posts of [dotsPosts, musePosts]) {
      expect(posts.map((post) => post.text).sort()).toEqual([...notes].sort());
      for (const item of writtenBy) {
        const post = posts.find((row) => row.text === item.text);
        expect(post?.author).toEqual({ id: item.agentId, displayName: NEW_AGENT_NAME });
        expect(post?.owner).toEqual({ id: item.ownerId, displayName: NEW_OWNER_NAME });
      }
      expect(new Set(posts.map((post) => post.owner.id)).size).toBe(3);
    }

    const close = "Report the result to your own owner. Say what was agreed, with whom, and anything still open.";
    expect(grokPage).toContain(`<p id="task-close">${close}</p>`);
    for (const agentKey of [dots.agentKey, muse.agentKey]) {
      const read = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}`, {
        headers: { authorization: `Bearer ${agentKey}` },
      });
      const body = (await read.json()) as { close?: string };
      expect(read.status).toBe(200);
      expect(body.close).toBe(close);
    }
  });

  it("G3 join, post, revoke, refused join, and 429 each have an audit row", async () => {
    const room = await hostRoom("Sunday lunch", 1);
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    await runInDurableObject(stub, (instance) => {
      instance.rememberBriefPostCap(room.roomId, 100);
    });
    const invite = room.invites[0];
    if (!invite) throw new Error("room:new did not mint an invite");
    const joined = await joinJson(room.roomId, invite);

    const posted = await postJson(room.roomId, joined.agentKey, "Grok Bot: bring forks");
    expect(posted.status).toBe(201);

    const refused = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joined.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: joined.agentId }),
    });
    expect(refused.status).toBe(403);
    await refused.arrayBuffer();

    for (let index = 0; index < 29; index += 1) {
      const again = await postJson(room.roomId, joined.agentKey, `Grok Bot: napkins ${index}`);
      expect(again.status).toBe(201);
      await again.arrayBuffer();
    }
    const limited = await postJson(room.roomId, joined.agentKey, "Grok Bot: one too many");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    await limited.arrayBuffer();

    const revoked = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}/agents/${joined.agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${room.credential}` },
    });
    expect(revoked.status).toBe(200);
    await revoked.arrayBuffer();

    const audit = await roomAudit(room.roomId);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "join", result: "ok" }),
        expect.objectContaining({ action: "post", result: "ok" }),
        expect.objectContaining({ action: "join_refused", result: "refused" }),
        expect.objectContaining({ action: "post", result: "refused", detailJson: expect.stringContaining("429") }),
      ]),
    );
    const hostJoin = audit.find(
      (row) => row.action === "join" && row.result === "ok" && row.agentId === room.hostAgentId,
    );
    expect(hostJoin?.ownerId.length).toBeGreaterThan(0);
    expect(revokeRow(audit, joined.agentId)).toEqual(
      expect.objectContaining({
        action: "setting_change",
        result: "ok",
        agentId: room.hostAgentId,
        ownerId: hostJoin?.ownerId,
      }),
    );
    expect(JSON.stringify(audit).includes(joined.agentKey)).toBe(false);
    expect(JSON.stringify(audit).includes(invite.secret)).toBe(false);
  }, 60_000);

  it("G4 an invite works once, an expired invite fails, and a revoked key is 401", async () => {
    const room = await hostRoom("Sunday lunch", 1);
    const invite = room.invites[0];
    if (!invite) throw new Error("room:new did not mint an invite");

    const joined = await joinJson(room.roomId, invite);
    const again = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}/${invite.id}/${invite.secret}`);
    const againBody = await again.text();
    expect(again.status).toBe(403);
    expect(againBody.includes(invite.secret)).toBe(false);
    expect(againBody.includes(joined.agentKey)).toBe(false);

    const minted = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${room.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresInSeconds: 1 }),
    });
    const mintedText = await minted.text();
    expect(minted.status).toBe(201);
    const link = (JSON.parse(mintedText) as { invite?: { link?: string } }).invite?.link ?? "";
    const expired = inviteFromLink(link);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const late = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}/${expired.id}/${expired.secret}`);
    const lateBody = await late.text();
    expect(late.status).toBe(403);
    expect(lateBody.includes(expired.secret)).toBe(false);

    const revoked = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}/agents/${joined.agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${room.credential}` },
    });
    expect(revoked.status).toBe(200);
    await revoked.arrayBuffer();

    const jsonPost = await postJson(room.roomId, joined.agentKey, "Grok Bot: after revoke");
    expect(jsonPost.status).toBe(401);
    await jsonPost.arrayBuffer();

    const form = await SELF.fetch(`https://room.example.test/r/${room.roomId}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${agentCookieName(room.roomId)}=${joined.agentKey}`,
      },
      body: new URLSearchParams({ nonce: "unused", text: "Grok Bot: after revoke" }),
    });
    const formBody = await form.text();
    expect(form.status).toBe(401);
    expect(formBody).toContain("This key was revoked.");
    expect(formBody.includes(joined.agentKey)).toBe(false);
  });
});

interface InviteLink {
  id: string;
  secret: string;
}

interface HostedRoom {
  roomId: string;
  credential: string;
  hostAgentId: string;
  invites: InviteLink[];
}

interface HtmlAgent {
  cookie: string;
  key: string;
  agentId: string;
}

interface JsonAgent {
  agentId: string;
  agentKey: string;
}

async function hostRoom(title: string, inviteCount: number): Promise<HostedRoom> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({ title, hostName: "Host (demo)", inviteCount }),
  });
  const body = await response.text();
  expect(response.status).toBe(201);
  expect(body.includes(hostSecret)).toBe(false);
  const created = JSON.parse(body) as {
    invites?: string[];
    roomId?: string;
    credential?: string;
    agentId?: string;
  };
  expect(created.agentId?.length).toBeGreaterThan(0);
  return {
    roomId: created.roomId ?? "",
    credential: created.credential ?? "",
    hostAgentId: created.agentId ?? "",
    invites: (created.invites ?? []).map(inviteFromLink),
  };
}

function inviteFromLink(link: string): InviteLink {
  const parts = new URL(link).pathname.split("/");
  return { id: parts[2] ?? "", secret: parts[3] ?? "" };
}

async function joinHtml(roomId: string, invite: InviteLink): Promise<HtmlAgent> {
  const opened = await SELF.fetch(`https://room.example.test/r/${roomId}/${invite.id}/${invite.secret}`, {
    redirect: "manual",
  });
  const openedBody = await opened.text();
  expect(opened.status).toBe(303);
  expect(openedBody.includes(invite.secret)).toBe(false);
  const name = agentCookieName(roomId);
  const header = opened.headers.getSetCookie().find((value) => value.startsWith(`${name}=`)) ?? "";
  const key = cookieValue(header, name);
  expect(/^[A-Za-z0-9_-]{20,}$/.test(key)).toBe(true);

  const page = await readHtml(roomId, header.split(";")[0] ?? `${name}=${key}`);
  expect(page.includes(`<pre>${key}</pre>`)).toBe(true);
  const agentId = await agentIdForKey(key);
  return { cookie: `${name}=${key}`, key, agentId };
}

async function joinJson(roomId: string, invite: InviteLink): Promise<JsonAgent> {
  const opened = await SELF.fetch(`https://room.example.test/api/r/${roomId}/${invite.id}/${invite.secret}`);
  const text = await opened.text();
  expect(opened.status).toBe(200);
  expect(text.includes(invite.secret)).toBe(false);
  const body = JSON.parse(text) as { agentId?: string; agentKey?: string };
  expect(/^[A-Za-z0-9_-]{20,}$/.test(body.agentKey ?? "")).toBe(true);
  return { agentId: body.agentId ?? "", agentKey: body.agentKey ?? "" };
}

async function postForm(roomId: string, agent: HtmlAgent, text: string): Promise<void> {
  const page = await readHtml(roomId, agent.cookie);
  const nonce = page.match(/name="nonce" value="([^"]+)"/)?.[1] ?? "";
  const posted = await SELF.fetch(`https://room.example.test/r/${roomId}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: agent.cookie,
    },
    body: new URLSearchParams({ nonce, text }),
  });
  expect(posted.status).toBe(303);
  await posted.arrayBuffer();
}

function postJson(roomId: string, agentKey: string, text: string): Promise<Response> {
  return SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
}

async function readHtml(roomId: string, cookie: string): Promise<string> {
  const response = await SELF.fetch(`https://room.example.test/r/${roomId}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.text();
}

async function readJson(roomId: string, agentKey: string): Promise<FeedPost[]> {
  const response = await SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
    headers: { authorization: `Bearer ${agentKey}` },
  });
  const body = (await response.json()) as { posts?: FeedPost[] };
  expect(response.status).toBe(200);
  return body.posts ?? [];
}

interface FeedPost {
  text: string;
  author: { id: string; displayName: string };
  owner: { id: string; displayName: string };
}

function cookieValue(header: string, name: string): string {
  const end = header.indexOf(";");
  const pair = end === -1 ? header : header.slice(0, end);
  return pair.slice(name.length + 1);
}

async function agentIdForKey(key: string): Promise<string> {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
  const hash = hashToken(key);
  const agentId = await runInDurableObject(stub, (instance) => {
    const rows = instance.auditSnapshot().filter((row) => row.action === "join" && row.result === "ok");
    for (const row of rows) {
      if (instance.agentKeyState(row.agentId)?.tokenHash === hash) return row.agentId;
    }
    return "";
  });
  expect(agentId.length).toBeGreaterThan(0);
  return agentId;
}

async function ownerIdsForAgents(roomId: string, agentIds: readonly string[]): Promise<string[]> {
  const audit = await roomAudit(roomId);
  return agentIds.map((agentId) => {
    const row = audit.find((entry) => entry.action === "join" && entry.result === "ok" && entry.agentId === agentId);
    return row?.ownerId ?? "";
  });
}

type AuditRow = { action: string; result: string; ownerId: string; agentId: string; detailJson: string };

function revokeRow(audit: readonly AuditRow[], revokedAgentId: string): AuditRow | undefined {
  return audit.find((row) => {
    if (row.action !== "setting_change" || row.result !== "ok") return false;
    const detail = JSON.parse(row.detailJson) as { itemId?: unknown };
    return detail.itemId === revokedAgentId;
  });
}

async function roomAudit(roomId: string): Promise<AuditRow[]> {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
  const rows = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
  return rows.filter((row) => row.room === roomId);
}
