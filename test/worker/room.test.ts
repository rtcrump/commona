import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";

describe("worker room", () => {
  it("answers health", async () => {
    const response = await SELF.fetch("https://room.example.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "commona" });
  });

  it("refuses a host room without the secret and audits the refusal", async () => {
    const response = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-commona-host-refusal": "1",
      },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    const body = await response.text();
    expect(response.status).toBe(403);
    expect(body).not.toContain(hostSecret);
    expect(body).not.toContain("inv_");
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const rows = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const refusal = rows.find((row) => row.action === "join_refused" && row.ownerId === "host");
    expect(refusal).toMatchObject({
      result: "refused",
      agentId: "owner:host",
      room: "*",
      detailJson: "{}",
    });
    expect(JSON.stringify(rows)).not.toContain(hostSecret);
  });

  // This stays ahead of the feed poll test. After that 429, a later test in this file cannot enter the object.
  it("redeems an invite after the Durable Object restarts", async () => {
    const response = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOST_SECRET_HEADER]: hostSecret,
      },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    const body = await response.text();
    expect(response.status).toBe(201);
    expect(body).not.toContain(hostSecret);
    const created = JSON.parse(body) as { invites?: string[] };
    const link = created.invites?.[0] ?? "";
    const parts = new URL(link).pathname.split("/");
    const id = parts[2] ?? "";
    const secret = parts[3] ?? "";
    expect(id).toMatch(/^inv_[0-9a-f-]{36}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(link).not.toContain("?");

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const before = await runInDurableObject(stub, (instance) => instance.inviteRecord(id));
    expect(before?.secretHash).toBe(hashToken(secret));
    expect(before?.usedAt).toBeNull();
    expect(before?.revokedAt).toBeNull();
    expect(Date.parse(before?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(JSON.stringify(before)).not.toContain(secret);

    await evictDurableObject(stub);

    const opened = await SELF.fetch(`https://room.example.test/j/${id}/${secret}`);
    expect(opened.status).toBe(200);
    const openedBody = await opened.text();
    expect(openedBody).not.toContain(secret);
    const cookie = opened.headers.getSetCookie().find((value) => value.startsWith("commona_invite="));
    expect(cookie?.split(";")[0]).toBe(`commona_invite=${secret}`);

    const bare = await SELF.fetch(`https://room.example.test/j/${id}`);
    expect(bare.headers.getSetCookie().some((value) => value.startsWith("commona_invite="))).toBe(false);
    await bare.arrayBuffer();

    const accepted = await SELF.fetch(`https://room.example.test/j/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `commona_invite=${secret}` },
      body: "{}",
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.text()).not.toContain(secret);

    const again = await SELF.fetch(`https://room.example.test/j/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `commona_invite=${secret}` },
      body: "{}",
    });
    expect(again.status).toBe(403);
    await again.arrayBuffer();

    const after = await runInDurableObject(stub, (instance) => instance.inviteRecord(id));
    expect(after?.usedAt).not.toBeNull();
    expect(after?.secretHash).toBe(hashToken(secret));
    expect(JSON.stringify(after)).not.toContain(secret);
  });

  // This stays ahead of the feed poll test. After that 429, a later test in this file cannot enter the object.
  // Response bodies are read before eviction. An unread body holds the object open and eviction waits.
  it("keeps the first name when the Durable Object restarts before finish", async () => {
    const response = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOST_SECRET_HEADER]: hostSecret,
      },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    const body = await response.text();
    expect(response.status).toBe(201);
    expect(body).not.toContain(hostSecret);
    const created = JSON.parse(body) as { invites?: string[] };
    const named = inviteParts(created.invites?.[0] ?? "");
    expect(named.id).toMatch(/^inv_[0-9a-f-]{36}$/);
    expect(named.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const namedPage = await SELF.fetch(`https://room.example.test/j/${named.id}/${named.secret}`, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    expect(namedPage.status).toBe(200);
    expect(await namedPage.text()).not.toContain(named.secret);
    const inviteCookie = cookiePair(namedPage.headers.getSetCookie(), "commona_invite");
    const formCookie = cookiePair(namedPage.headers.getSetCookie(), "commona_form");
    expect(inviteCookie).toBe(`commona_invite=${named.secret}`);
    const continued = await SELF.fetch(`https://room.example.test/j/${named.id}/continue`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${inviteCookie}; ${formCookie}`,
      },
      body: new URLSearchParams({ nonce: cookieValue(formCookie), firstName: "Alex" }),
    });
    expect(continued.status).toBe(303);
    expect(continued.headers.get("location")).toBe(`/j/${named.id}/sharing`);
    expect(await continued.text()).not.toContain(named.secret);

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const pending = await runInDurableObject(stub, (instance) => instance.pendingName(named.id));
    expect(pending).toEqual({ firstName: "Alex", secretHash: hashToken(named.secret) });
    expect(JSON.stringify(pending)).not.toContain(named.secret);

    await evictDurableObject(stub);

    const sharing = await SELF.fetch(`https://room.example.test/j/${named.id}/sharing`, {
      redirect: "manual",
      headers: { accept: "text/html", cookie: inviteCookie },
    });
    expect(sharing.status).toBe(200);
    expect(await sharing.text()).not.toContain(named.secret);
    const shareForm = cookiePair(sharing.headers.getSetCookie(), "commona_form");
    const finished = await SELF.fetch(`https://room.example.test/j/${named.id}/finish`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${inviteCookie}; ${shareForm}`,
      },
      body: new URLSearchParams({ nonce: cookieValue(shareForm), seeing: "Nothing" }),
    });
    const finishedBody = await finished.text();
    expect(finished.status).toBe(303);
    expect(finished.headers.get("location")).toBe(`/j/${named.id}/done`);
    expect(finishedBody).not.toContain(named.secret);
    const names = await runInDurableObject(stub, (instance) => instance.ownerDisplayNames());
    expect(names).toContain("Alex");
    expect(await runInDurableObject(stub, (instance) => instance.pendingName(named.id))).toBeNull();
  });

  it("creates a room with the host secret even when a forwarded header is set", async () => {
    const response = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOST_SECRET_HEADER]: hostSecret,
        "cf-connecting-ip": "203.0.113.8",
      },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    const body = await response.text();
    expect(response.status).toBe(201);
    expect(body).not.toContain(hostSecret);
    const created = JSON.parse(body) as { credential?: string; roomId?: string };
    expect(created.roomId).toMatch(/^room_/);
    expect(created.credential).toBeTruthy();

    const feed = await SELF.fetch(`https://room.example.test/rooms/${created.roomId}/feed`, {
      headers: { authorization: `Bearer ${created.credential}` },
    });
    expect(feed.status).toBe(200);
    const again = await SELF.fetch(`https://room.example.test/rooms/${created.roomId}/feed`, {
      headers: { authorization: `Bearer ${created.credential}` },
    });
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("30");
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.json()).toEqual({ error: { code: "validation", message: "Try again later." } });
  });
});

function inviteParts(link: string): { id: string; secret: string } {
  const parts = new URL(link).pathname.split("/");
  return { id: parts[2] ?? "", secret: parts[3] ?? "" };
}

function cookiePair(setCookies: string[], name: string): string {
  const raw = setCookies.find((value) => value.startsWith(`${name}=`));
  expect(raw).toBeTruthy();
  return (raw ?? "").split(";")[0] ?? "";
}

function cookieValue(pair: string): string {
  const eq = pair.indexOf("=");
  return eq === -1 ? "" : pair.slice(eq + 1);
}
