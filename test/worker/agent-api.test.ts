import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { NEW_AGENT_NAME, NEW_OWNER_NAME } from "../../src/onboarding/account.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { agentCookieName } from "../../src/room-page/routes.js";

const hostSecret = "host-test-secret";
const note = "Bring napkins";

const CLIENTS: { name: string; headers: Record<string, string> }[] = [
  { name: "python-urllib", headers: { "user-agent": "Python-urllib/3.12", "accept-encoding": "identity" } },
  { name: "curl", headers: { "user-agent": "curl/8.5.0", accept: "*/*" } },
  {
    name: "node-fetch",
    headers: {
      "user-agent": "node",
      accept: "*/*",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "accept-encoding": "gzip, deflate",
    },
  },
  { name: "no-user-agent", headers: {} },
];

describe("worker agent json api", () => {
  it("joins over HTTPS using only the hosted invite link and audits replay", async () => {
    const created = await hostRoom("Fake link-only lunch");
    const url = new URL(created.link);
    url.pathname = `/api${url.pathname}`;
    const opened = await SELF.fetch(url);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const joined = await opened.json() as Joined & { roomId: string; sharingKey: string };
    expect(joined.roomId).toBe(created.roomId);
    expect(joined.agentKey.length).toBeGreaterThan(20);
    expect(joined.sharingKey.length).toBeGreaterThan(20);
    const replay = await SELF.fetch(url);
    expect(replay.status).toBe(403);
    await replay.arrayBuffer();
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    expect(audit.some((row) => row.action === "join_refused" && row.result === "refused")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(created.secret);
    expect(JSON.stringify(audit)).not.toContain(joined.agentKey);
  });

  it("stores the key hash and the post window in the durable object, and revokes the key", async () => {
    const created = await hostRoom("Sunday lunch");
    const head = await SELF.fetch(
      `https://room.example.test/api/r/${created.roomId}/${created.id}/${created.secret}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    await head.arrayBuffer();

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const before = await runInDurableObject(stub, (instance) => instance.inviteRecord(created.id));
    expect(before?.usedAt).toBeNull();
    expect(before?.secretHash).toBe(hashToken(created.secret));

    const opened = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?t=${created.secret}`);
    const openedText = await opened.text();
    expect(opened.status).toBe(200);
    expect(openedText.includes(created.secret)).toBe(false);
    expect(openedText.includes(created.credential)).toBe(false);
    expect(openedText.includes(hostSecret)).toBe(false);
    const joined = JSON.parse(openedText) as Joined & { ownerId: string };
    expect(joined.title).toBe("Sunday lunch");
    expect(/^[A-Za-z0-9_-]{20,}$/.test(joined.agentKey)).toBe(true);
    expect(openedText.includes(hashToken(joined.agentKey))).toBe(false);

    const state = await runInDurableObject(stub, (instance) => instance.agentKeyState(joined.agentId));
    expect(state?.tokenHash).toBe(hashToken(joined.agentKey));
    expect(state?.revokedHash).toBeNull();
    expect(JSON.stringify(state).includes(joined.agentKey)).toBe(false);

    const posted = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joined.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: note,
        author: { id: "agent_spoofed", displayName: "Spoofed Agent" },
        owner: { id: "owner_spoofed", displayName: "Spoofed Owner" },
        authorAgentId: "A2",
        authorOwnerId: "O2",
      }),
    });
    expect(posted.status).toBe(201);
    const postedText = await posted.text();
    expect(postedText).toContain(note);
    expect(postedText.includes("spoofed")).toBe(false);
    expect(postedText.includes("Spoofed")).toBe(false);
    const hits = await runInDurableObject(stub, (instance) => instance.postHitCount(joined.agentId));
    expect(hits).toBe(1);

    const read = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      headers: { authorization: `Bearer ${joined.agentKey}` },
    });
    const feed = (await read.json()) as {
      posts: { text: string; author: { id: string; displayName: string }; owner: { id: string; displayName: string } }[];
    };
    expect(feed.posts).toEqual([
      {
        text: note,
        author: { id: joined.agentId, displayName: NEW_AGENT_NAME },
        owner: { id: joined.ownerId, displayName: NEW_OWNER_NAME },
      },
    ]);
    expect(JSON.stringify(feed).includes("spoofed")).toBe(false);
    expect(JSON.stringify(feed).includes("Spoofed")).toBe(false);

    const revoked = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}/agents/${joined.agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${created.credential}` },
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });

    const after = await runInDurableObject(stub, (instance) => instance.agentKeyState(joined.agentId));
    expect(after?.tokenHash).toBeNull();
    expect(after?.revokedHash).toBe(hashToken(joined.agentKey));
    expect(JSON.stringify(after).includes(joined.agentKey)).toBe(false);

    const denied = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joined.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: note }),
    });
    expect(denied.status).toBe(401);
    await denied.arrayBuffer();

    const form = await SELF.fetch(`https://room.example.test/r/${created.roomId}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${agentCookieName(created.roomId)}=${joined.agentKey}`,
      },
      body: new URLSearchParams({ nonce: "unused", text: note }),
    });
    const formBody = await form.text();
    expect(form.status).toBe(401);
    expect(formBody).toContain("This key was revoked.");
    expect(formBody.includes(joined.agentKey)).toBe(false);

    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    expect(audit.some((row) => row.action === "join" && row.result === "ok")).toBe(true);
    expect(audit.some((row) => row.action === "post" && row.result === "ok")).toBe(true);
    expect(audit.some((row) => row.action === "setting_change" && row.result === "ok")).toBe(true);
    const auditText = JSON.stringify(audit);
    expect(auditText.includes(joined.agentKey)).toBe(false);
    expect(auditText.includes(created.secret)).toBe(false);
    expect(auditText.includes(created.credential)).toBe(false);
    expect(auditText.includes(hostSecret)).toBe(false);
  });

  it("returns 429 from durable object sqlite after 30 posts in an hour", async () => {
    const created = await hostRoom("Sunday lunch");
    const stubForCap = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    await runInDurableObject(stubForCap, (instance) => {
      instance.rememberBriefPostCap(created.roomId, 100);
    });
    const opened = await SELF.fetch(
      `https://room.example.test/api/r/${created.roomId}/${created.id}/${created.secret}`,
    );
    const joined = JSON.parse(await opened.text()) as Joined;
    expect(opened.status).toBe(200);

    for (let index = 0; index < 30; index += 1) {
      const posted = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${joined.agentKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: `${note} ${index}` }),
      });
      expect(posted.status).toBe(201);
      await posted.arrayBuffer();
    }

    const limited = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joined.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: note }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(await limited.json()).toEqual({ error: { code: "validation", message: "Try again later." } });

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const hits = await runInDurableObject(stub, (instance) => instance.postHitCount(joined.agentId));
    expect(hits).toBe(30);
    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const refusal = audit.find(
      (row) => row.room === created.roomId && row.action === "post" && row.result === "refused",
    );
    expect(refusal?.detailJson).toContain("429");
    expect(JSON.stringify(audit).includes(joined.agentKey)).toBe(false);
  }, 60_000);

  it("joins, reads, and posts for urllib, curl, node fetch, and a request with no User-Agent", async () => {
    const created = await hostRoom("Sunday lunch", CLIENTS.length);
    expect(created.invites).toHaveLength(CLIENTS.length);
    for (let index = 0; index < CLIENTS.length; index += 1) {
      const client = CLIENTS[index];
      const invite = created.invites[index];
      if (!client || !invite) throw new Error("missing client");
      const joined = await SELF.fetch(
        `https://room.example.test/api/r/${created.roomId}/${invite.id}/${invite.secret}`,
        { headers: client.headers },
      );
      expect(joined.status).toBe(200);
      const body = JSON.parse(await joined.text()) as { agentKey: string; rules: string[] };
      expect(body.rules.join("\n")).toContain("Work from the brief.");
      expect(body.rules.join("\n")).toContain("Post only free times and place preferences, never raw calendar entries.");
      const headers = { ...client.headers, authorization: `Bearer ${body.agentKey}` };
      const read = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?since=0`, { headers });
      expect(read.status).toBe(200);
      const page = (await read.json()) as { posts: { text: string }[]; cursor: string };
      expect(Array.isArray(page.posts)).toBe(true);
      expect(page.cursor.length).toBeGreaterThan(0);
      const note = `Bring napkins ${client.name}`;
      const posted = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text: note }),
      });
      expect(posted.status).toBe(201);
      await posted.arrayBuffer();
      const again = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?since=0`, { headers });
      expect(again.status).toBe(200);
      const seen = await again.text();
      expect(seen).toContain(note);
    }
  });

  it("waits for a visible post, ignores a hidden one, and caps posts from the brief", async () => {
    const created = await hostRoom("Sunday lunch", 2);
    const [readerInvite, authorInvite] = created.invites;
    if (!readerInvite || !authorInvite) throw new Error("room:new did not mint two invites");
    const reader = await joinAgent(created.roomId, readerInvite);
    const author = await joinAgent(created.roomId, authorInvite);
    const first = await postNote(created.roomId, author.agentKey, "Tuesday noon is free");
    const opened = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?since=0`, {
      headers: { authorization: `Bearer ${reader.agentKey}` },
    });
    expect(opened.status).toBe(200);
    const firstPage = (await opened.json()) as { posts: { id: string; text: string }[]; cursor: string };
    expect(firstPage.posts.map((post) => post.text)).toEqual(["Tuesday noon is free"]);
    expect(firstPage.cursor).toBe(first);

    const pending = SELF.fetch(
      `https://room.example.test/api/r/${created.roomId}?since=${firstPage.cursor}&wait=25`,
      { headers: { authorization: `Bearer ${reader.agentKey}` } },
    );
    await delay(40);
    const second = await postNote(created.roomId, author.agentKey, "The park is free at noon");
    const waited = await pending;
    expect(waited.status).toBe(200);
    const waitedBody = (await waited.json()) as { posts: { id: string; text: string }[]; cursor: string };
    expect(waitedBody.posts).toEqual([{ id: second, text: "The park is free at noon" }]);

    const bad = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?since=nope`, {
      headers: { authorization: `Bearer ${reader.agentKey}` },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "validation", message: "That cursor is not valid." } });
    const tooLong = await SELF.fetch(
      `https://room.example.test/api/r/${created.roomId}?since=${second}&wait=26`,
      { headers: { authorization: `Bearer ${reader.agentKey}` } },
    );
    expect(tooLong.status).toBe(400);
    await tooLong.arrayBuffer();

    const narrowed = await SELF.fetch(`https://room.example.test/api/rooms/${created.roomId}/sharing`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${author.sharingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fromOwnerId: author.ownerId, toOwnerId: reader.ownerId, level: "none" }),
    });
    expect(narrowed.status).toBe(200);
    await narrowed.arrayBuffer();
    const hiddenWait = SELF.fetch(
      `https://room.example.test/api/r/${created.roomId}?since=${second}&wait=1`,
      { headers: { authorization: `Bearer ${reader.agentKey}` } },
    );
    await delay(40);
    const hidden = await postNote(created.roomId, author.agentKey, "Raw calendar: dentist Tuesday 13:00");
    const hiddenResponse = await hiddenWait;
    const hiddenText = await hiddenResponse.text();
    expect(hiddenResponse.status).toBe(200);
    expect(JSON.parse(hiddenText)).toMatchObject({ posts: [], cursor: second });
    expect(hiddenText.includes("Raw calendar: dentist Tuesday 13:00")).toBe(false);
    expect(hiddenText.includes(hidden)).toBe(false);

    const plain = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}?since=${second}`, {
      headers: { authorization: `Bearer ${reader.agentKey}` },
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ posts: [], cursor: second });

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    await runInDurableObject(stub, (instance) => {
      instance.rememberBriefPostCap(created.roomId, 3);
    });
    const capped = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${author.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Bring forks" }),
    });
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBeNull();
    expect(await capped.json()).toEqual({
      error: { code: "validation", message: "This task allows 3 posts in this room. That limit has been reached." },
    });
    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const refusal = audit.find(
      (row) => row.room === created.roomId && row.action === "post" && row.result === "refused",
    );
    expect(refusal?.detailJson).toContain("429");
  }, 15_000);
});

interface Joined {
  agentId: string;
  agentKey: string;
  title: string;
}

async function hostRoom(
  title: string,
  inviteCount = 1,
): Promise<{
  roomId: string;
  id: string;
  secret: string;
  credential: string;
  link: string;
  invites: { id: string; secret: string }[];
}> {
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
  const created = JSON.parse(body) as { invites?: string[]; roomId?: string; credential?: string };
  const invites = (created.invites ?? []).map((link) => {
    const parts = new URL(link).pathname.split("/");
    return { id: parts[2] ?? "", secret: parts[3] ?? "" };
  });
  const first = invites[0];
  return {
    link: created.invites?.[0] ?? "",
    roomId: created.roomId ?? "",
    id: first?.id ?? "",
    secret: first?.secret ?? "",
    credential: created.credential ?? "",
    invites,
  };
}

async function joinAgent(
  roomId: string,
  invite: { id: string; secret: string },
): Promise<{ agentKey: string; ownerId: string; sharingKey: string }> {
  const opened = await SELF.fetch(`https://room.example.test/api/r/${roomId}/${invite.id}/${invite.secret}`);
  expect(opened.status).toBe(200);
  return JSON.parse(await opened.text()) as { agentKey: string; ownerId: string; sharingKey: string };
}

async function postNote(roomId: string, agentKey: string, text: string): Promise<string> {
  await delay(20);
  const posted = await SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  expect(posted.status).toBe(201);
  return ((await posted.json()) as { post: { id: string } }).post.id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
