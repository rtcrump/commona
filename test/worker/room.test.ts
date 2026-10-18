import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
