import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

/** Fictional room note. Not a person, and not a patient record. */
const NOTE = "Bring paper cups";

describe("join response addresses", () => {
  let room: JoinHarness | undefined;
  let previousOrigin: string | undefined;

  afterEach(async () => {
    if (previousOrigin === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previousOrigin;
    previousOrigin = undefined;
    await room?.stop();
    room = undefined;
  });

  it("posts, reads the room feed, and changes sharing using only the returned addresses", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    process.env.COMMONA_PUBLIC_ORIGIN = room.baseUrl;
    const alpha = await join(room);
    const beta = await join(room);

    expect(alpha.addresses.post.url).toBe(`${room.baseUrl}/api/r/${alpha.roomId}`);
    expect(alpha.addresses.read.url).toBe(`${room.baseUrl}/api/r/${alpha.roomId}`);
    expect(alpha.addresses.feed.url).toBe(`${room.baseUrl}/rooms/${alpha.roomId}/feed`);
    expect(alpha.addresses.sharing.url).toBe(`${room.baseUrl}/api/rooms/${alpha.roomId}/sharing`);
    expect(beta.addresses.feed.url).toBe(alpha.addresses.feed.url);
    for (const joined of [alpha, beta]) {
      for (const address of Object.values(joined.addresses)) {
        const url = new URL(address.url);
        expect(url.origin).toBe(room.baseUrl);
        expect(url.username).toBe("");
        expect(url.search).toBe("");
        expect(address.url.includes(joined.agentKey)).toBe(false);
        expect(address.url.includes(joined.sharingKey)).toBe(false);
      }
    }

    const posted = await follow(alpha.addresses.post, alpha.agentKey, { text: NOTE });
    expect(posted.status).toBe(201);
    expect(posted.body).toContain(NOTE);

    const feed = await follow(beta.addresses.feed, beta.agentKey);
    expect(feed.status).toBe(200);
    expect(messageTexts(feed.body)).toContain(NOTE);
    const posts = await follow(beta.addresses.read, beta.agentKey);
    expect(posts.status).toBe(200);
    expect(postTexts(posts.body)).toContain(NOTE);

    const shared = await follow(alpha.addresses.sharing, alpha.sharingKey, {
      fromOwnerId: alpha.ownerId,
      toOwnerId: beta.ownerId,
      level: "none",
    });
    expect(shared.status).toBe(200);
    expect(JSON.parse(shared.body)).toMatchObject({
      sharing: { fromOwnerId: alpha.ownerId, toOwnerId: beta.ownerId, level: "none" },
    });

    const hiddenFeed = await follow(beta.addresses.feed, beta.agentKey);
    expect(hiddenFeed.status).toBe(200);
    expect(messageTexts(hiddenFeed.body)).not.toContain(NOTE);
    const hiddenPosts = await follow(beta.addresses.read, beta.agentKey);
    expect(postTexts(hiddenPosts.body)).not.toContain(NOTE);
    const ownPosts = await follow(alpha.addresses.read, alpha.agentKey);
    expect(postTexts(ownPosts.body)).toContain(NOTE);
    expect(room.sharing.level(alpha.roomId, alpha.ownerId, beta.ownerId)).toBe("none");
  });

  it("returns the same absolute addresses from the room-id join route", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    process.env.COMMONA_PUBLIC_ORIGIN = room.baseUrl;
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/")[3] ?? "";
    const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.addresses.post).toEqual({ method: "POST", url: `${room.baseUrl}/api/r/${joined.roomId}` });
    expect(joined.addresses.read).toEqual({ method: "GET", url: `${room.baseUrl}/api/r/${joined.roomId}` });
    expect(joined.addresses.feed).toEqual({ method: "GET", url: `${room.baseUrl}/rooms/${joined.roomId}/feed` });
    expect(joined.addresses.sharing).toEqual({
      method: "PUT",
      url: `${room.baseUrl}/api/rooms/${joined.roomId}/sharing`,
    });
    expect(opened.body.includes(secret)).toBe(false);
    const posted = await follow(joined.addresses.post, joined.agentKey, { text: NOTE });
    expect(posted.status).toBe(201);
  });

  it("normalizes a trailing-slash origin in the returned addresses", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    process.env.COMMONA_PUBLIC_ORIGIN = `${room.baseUrl}/`;
    const joined = await join(room);

    expect(joined.addresses.post).toEqual({ method: "POST", url: `${room.baseUrl}/api/r/${joined.roomId}` });
    expect(joined.addresses.read).toEqual({ method: "GET", url: `${room.baseUrl}/api/r/${joined.roomId}` });
    expect(joined.addresses.feed).toEqual({ method: "GET", url: `${room.baseUrl}/rooms/${joined.roomId}/feed` });
    expect(joined.addresses.sharing).toEqual({
      method: "PUT",
      url: `${room.baseUrl}/api/rooms/${joined.roomId}/sharing`,
    });
    for (const address of Object.values(joined.addresses)) {
      expect(address.url.includes(`${room.baseUrl}//`)).toBe(false);
    }

    const posted = await follow(joined.addresses.post, joined.agentKey, { text: NOTE });
    expect(posted.status).toBe(201);
    expect(posted.body).toContain(NOTE);
  });

  it("normalizes an uppercase host and an explicit default port", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    process.env.COMMONA_PUBLIC_ORIGIN = "https://EXAMPLE.com:443/";
    const joined = await join(room);
    const origin = "https://example.com";
    expect(joined.addresses.post).toEqual({ method: "POST", url: `${origin}/api/r/${joined.roomId}` });
    expect(joined.addresses.read).toEqual({ method: "GET", url: `${origin}/api/r/${joined.roomId}` });
    expect(joined.addresses.feed).toEqual({ method: "GET", url: `${origin}/rooms/${joined.roomId}/feed` });
    expect(joined.addresses.sharing).toEqual({ method: "PUT", url: `${origin}/api/rooms/${joined.roomId}/sharing` });
    expect(joined.agentKey.length).toBeGreaterThan(0);
  });

  it("rejects a malformed origin and leaves the invite unused", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    process.env.COMMONA_PUBLIC_ORIGIN = room.baseUrl;
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/").at(-1) ?? "";
    const linkPath = `/api${invite.openPath}`;
    const roomPath = `/api/r/${room.roomId}/${invite.id}/${secret}`;
    const owners = ownerCount(room);

    for (const bad of ["https://example.com/extra", "example.com", "https://0x7f000001", "https://example.com:0443"]) {
      process.env.COMMONA_PUBLIC_ORIGIN = bad;
      const rejected = await call(room.baseUrl, "GET", linkPath);
      expect(rejected.status, bad).toBe(400);
      expect(JSON.parse(rejected.body)).toEqual({
        error: { code: "validation", message: "COMMONA_PUBLIC_ORIGIN must be an https origin" },
      });
      expect(rejected.body.includes(secret)).toBe(false);
      expect(rejected.body.includes(bad)).toBe(false);
      expect(usedAt(room, invite.id)).toBeNull();
    }

    process.env.COMMONA_PUBLIC_ORIGIN = "http://join.example.test";
    const roomRoute = await call(room.baseUrl, "GET", roomPath);
    expect(roomRoute.status).toBe(400);
    expect(roomRoute.body.includes(secret)).toBe(false);
    expect(usedAt(room, invite.id)).toBeNull();
    expect(ownerCount(room)).toBe(owners);

    process.env.COMMONA_PUBLIC_ORIGIN = room.baseUrl;
    const opened = await call(room.baseUrl, "GET", linkPath);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.addresses.post.url).toBe(`${room.baseUrl}/api/r/${joined.roomId}`);
    expect(joined.addresses.read.url).toBe(`${room.baseUrl}/api/r/${joined.roomId}`);
    expect(joined.addresses.sharing.url).toBe(`${room.baseUrl}/api/rooms/${joined.roomId}/sharing`);
    expect(usedAt(room, invite.id)).not.toBeNull();
    const replay = await call(room.baseUrl, "GET", roomPath);
    expect(replay.status).toBe(403);
  });

  it("uses the request host when no public origin is set", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    delete process.env.COMMONA_PUBLIC_ORIGIN;
    const joined = await join(room);

    expect(joined.addresses.post.url).toBe(`${room.baseUrl}/api/r/${joined.roomId}`);
    expect(joined.addresses.read.url).toBe(`${room.baseUrl}/api/r/${joined.roomId}`);
    expect(joined.addresses.feed.url).toBe(`${room.baseUrl}/rooms/${joined.roomId}/feed`);
    expect(joined.addresses.sharing.url).toBe(`${room.baseUrl}/api/rooms/${joined.roomId}/sharing`);
    const posted = await follow(joined.addresses.post, joined.agentKey, { text: NOTE });
    expect(posted.status).toBe(201);
    expect(posted.body).toContain(NOTE);
  });

  it("normalizes an uppercase default-port Host header before the invite is used", async () => {
    previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
    room = await startJoinHarness();
    delete process.env.COMMONA_PUBLIC_ORIGIN;
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/").at(-1) ?? "";
    const opened = await requestWithHost(room.baseUrl, `/api${invite.openPath}`, "EXAMPLE.com:443");
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    const origin = "https://example.com";
    expect(joined.addresses.post).toEqual({ method: "POST", url: `${origin}/api/r/${joined.roomId}` });
    expect(joined.addresses.read).toEqual({ method: "GET", url: `${origin}/api/r/${joined.roomId}` });
    expect(joined.addresses.feed).toEqual({ method: "GET", url: `${origin}/rooms/${joined.roomId}/feed` });
    expect(joined.addresses.sharing).toEqual({ method: "PUT", url: `${origin}/api/rooms/${joined.roomId}/sharing` });
    expect(opened.body.includes(secret)).toBe(false);
    expect(joined.agentKey.length).toBeGreaterThan(0);
    expect(usedAt(room, invite.id)).not.toBeNull();
  });
});

interface JoinAddress {
  method: string;
  url: string;
}

interface Joined {
  roomId: string;
  ownerId: string;
  agentKey: string;
  sharingKey: string;
  addresses: { post: JoinAddress; read: JoinAddress; feed: JoinAddress; sharing: JoinAddress };
}

async function join(room: JoinHarness): Promise<Joined> {
  const invite = await createInvite(room);
  const opened = await call(room.baseUrl, "GET", `/api${invite.openPath}`);
  expect(opened.status).toBe(200);
  const joined = JSON.parse(opened.body) as Joined;
  expect(joined.addresses.post.method).toBe("POST");
  expect(joined.addresses.read.method).toBe("GET");
  expect(joined.addresses.feed.method).toBe("GET");
  expect(joined.addresses.sharing.method).toBe("PUT");
  const secret = invite.openPath.split("/").at(-1) ?? "";
  expect(secret.length).toBeGreaterThan(0);
  for (const address of Object.values(joined.addresses)) expect(address.url.includes(secret)).toBe(false);
  return joined;
}

async function follow(
  address: JoinAddress,
  token: string,
  json?: unknown,
): Promise<{ status: number; body: string }> {
  const url = new URL(address.url);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(url, { method: address.method, headers, body, redirect: "manual" });
  return { status: response.status, body: await response.text() };
}

function postTexts(body: string): string[] {
  const parsed = JSON.parse(body) as { posts?: { text?: string }[] };
  return (parsed.posts ?? []).map((post) => post.text ?? "");
}

function usedAt(room: JoinHarness, inviteId: string): string | null {
  const row = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(inviteId) as { used_at: string | null };
  return row.used_at;
}

function ownerCount(room: JoinHarness): number {
  return Number((room.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n);
}

function requestWithHost(
  baseUrl: string,
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: "GET",
        headers: { host, accept: "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function messageTexts(body: string): string[] {
  const parsed = JSON.parse(body) as { items?: { kind?: string; text?: string }[] };
  return (parsed.items ?? []).filter((item) => item.kind === "message").map((item) => item.text ?? "");
}
