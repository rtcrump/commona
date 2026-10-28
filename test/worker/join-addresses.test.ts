import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

/** Fictional room note. Not a person, and not a patient record. */
const NOTE = "Bring paper cups";
const PUBLIC_ORIGIN = "https://join.example.test";

describe("worker join addresses", () => {
  it("posts, reads the room feed, and changes sharing using only the returned addresses", async () => {
    const created = await hostRoom();
    const [firstLink, secondLink] = created.invites;
    if (!firstLink || !secondLink) throw new Error("room:new did not mint two invites");
    const alpha = await join(firstLink);
    const beta = await join(secondLink);

    for (const joined of [alpha, beta]) {
      for (const address of Object.values(joined.addresses)) {
        const url = new URL(address.url);
        expect(url.origin).toBe(PUBLIC_ORIGIN);
        expect(url.username).toBe("");
        expect(url.search).toBe("");
        expect(address.url.startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true);
        expect(address.url.includes(joined.agentKey)).toBe(false);
        expect(address.url.includes(joined.sharingKey)).toBe(false);
      }
    }
    expect(alpha.addresses.post.url).toBe(`${PUBLIC_ORIGIN}/api/r/${alpha.roomId}`);
    expect(alpha.addresses.feed.url).toBe(`${PUBLIC_ORIGIN}/rooms/${alpha.roomId}/feed`);
    expect(alpha.addresses.sharing.url).toBe(`${PUBLIC_ORIGIN}/rooms/${alpha.roomId}/sharing`);

    const posted = await follow(alpha.addresses.post, alpha.agentKey, { text: NOTE });
    expect(posted.status).toBe(201);

    const feed = await follow(beta.addresses.feed, beta.agentKey);
    expect(feed.status).toBe(200);
    expect(messageTexts(feed.body)).toContain(NOTE);

    const shared = await follow(alpha.addresses.sharing, alpha.sharingKey, {
      fromOwnerId: alpha.ownerId,
      toOwnerId: beta.ownerId,
      level: "none",
    });
    expect(shared.status).toBe(200);
    expect(JSON.parse(shared.body)).toMatchObject({
      sharing: { fromOwnerId: alpha.ownerId, toOwnerId: beta.ownerId, level: "none" },
    });

    const hidden = await follow(beta.addresses.read, beta.agentKey);
    expect(hidden.status).toBe(200);
    expect(postTexts(hidden.body)).not.toContain(NOTE);
    const own = await follow(alpha.addresses.read, alpha.agentKey);
    expect(postTexts(own.body)).toContain(NOTE);
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

async function hostRoom(): Promise<{ invites: string[] }> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: "host-test-secret",
    },
    body: JSON.stringify({ title: "Sample lunch", hostName: "Host (demo)", inviteCount: 2 }),
  });
  const body = await response.text();
  expect(response.status).toBe(201);
  const created = JSON.parse(body) as { invites?: string[] };
  return { invites: created.invites ?? [] };
}

async function join(link: string): Promise<Joined> {
  const url = new URL(link);
  url.pathname = `/api${url.pathname}`;
  const opened = await SELF.fetch(url);
  expect(opened.status).toBe(200);
  const joined = (await opened.json()) as Joined;
  expect(joined.addresses.post.method).toBe("POST");
  expect(joined.addresses.read.method).toBe("GET");
  expect(joined.addresses.feed.method).toBe("GET");
  expect(joined.addresses.sharing.method).toBe("PUT");
  return joined;
}

async function follow(
  address: JoinAddress,
  token: string,
  json?: unknown,
): Promise<{ status: number; body: string }> {
  const response = await SELF.fetch(address.url, {
    method: address.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { status: response.status, body: await response.text() };
}

function postTexts(body: string): string[] {
  const parsed = JSON.parse(body) as { posts?: { text?: string }[] };
  return (parsed.posts ?? []).map((post) => post.text ?? "");
}

function messageTexts(body: string): string[] {
  const parsed = JSON.parse(body) as { items?: { kind?: string; text?: string }[] };
  return (parsed.items ?? []).filter((item) => item.kind === "message").map((item) => item.text ?? "");
}
