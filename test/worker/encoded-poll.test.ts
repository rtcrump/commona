import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

describe("worker encoded feed poll", () => {
  it.each([false, true])("limits an encoded room id after a plain poll (encoded route: %s)", async (encodedRoute) => {
    const created = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: { "content-type": "application/json", [HOST_SECRET_HEADER]: "host-test-secret" },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { roomId: string; credential: string };
    const headers = { authorization: `Bearer ${room.credential}` };
    const first = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/feed`, { headers });
    expect(first.status).toBe(200);
    await first.text();

    const encodedId = room.roomId.replace("room_", "%72%6f%6Fm%5f");
    const path = encodedRoute ? `/%72ooms/${encodedId}/%66eed` : `/rooms/${encodedId}/feed`;
    const again = await SELF.fetch(`https://room.example.test${path}`, { headers });
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("30");
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.json()).toEqual({ error: { code: "validation", message: "Try again later." } });
  });

  it.each(["%", "%7", "%GG", "%C3%28"])("refuses malformed room encoding %s", async (encoding) => {
    const response = await SELF.fetch(`https://room.example.test/rooms/room_${encoding}/feed`);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });
  });
});
