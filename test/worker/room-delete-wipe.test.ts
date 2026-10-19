import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";

describe("worker room delete wipe", () => {
  it("clears Durable Object storage and the alarm when the owner deletes the only room", async () => {
    const response = await SELF.fetch("https://room.example.test/host/room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOST_SECRET_HEADER]: hostSecret,
      },
      body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
    });
    const text = await response.text();
    expect(response.status).toBe(201);
    const created = JSON.parse(text) as {
      invites?: string[];
      credential?: string;
      roomId?: string;
      agentId?: string;
    };
    const roomId = created.roomId ?? "";
    const credential = created.credential ?? "";
    const agentId = created.agentId ?? "";
    const link = created.invites?.[0] ?? "";
    const parts = new URL(link).pathname.split("/");
    const inviteId = parts[2] ?? "";
    const secret = parts[3] ?? "";
    expect(roomId).toMatch(/^room_/);
    expect(credential).toMatch(/^[A-Za-z0-9_-]+$/);

    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const before = await runInDurableObject(directory, (instance) => instance.auditSnapshot());
    expect(before.length).toBeGreaterThan(0);
    await runInDurableObject(directory, (instance) => instance.scheduleAlarm(Date.now() + 60_000));
    expect(await runInDurableObject(directory, (instance) => instance.scheduledAlarm())).not.toBeNull();

    const deleted = await SELF.fetch(`https://room.example.test/rooms/${roomId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential}` },
    });
    const deletedText = await deleted.text();
    expect(deleted.status).toBe(200);
    const body = JSON.parse(deletedText) as {
      deleted?: boolean;
      audit?: { action?: string; result?: string; room?: string; detail?: { itemId?: string }; hash?: string };
    };
    expect(body.deleted).toBe(true);
    expect(body.audit).toMatchObject({
      action: "setting_change",
      result: "ok",
      room: roomId,
      detail: { itemId: roomId },
    });
    expect(body.audit?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(deletedText).not.toContain(credential);
    expect(deletedText).not.toContain(secret);
    expect(deletedText).not.toContain(hostSecret);

    expect(await runInDurableObject(directory, (instance) => instance.auditSnapshot())).toEqual([]);
    expect(await runInDurableObject(directory, (instance) => instance.scheduledAlarm())).toBeNull();
    expect(await runInDurableObject(directory, (instance) => instance.inviteRecord(inviteId))).toBeNull();

    await evictDurableObject(directory);

    expect(await runInDurableObject(directory, (instance) => instance.auditSnapshot())).toEqual([]);
    expect(await runInDurableObject(directory, (instance) => instance.scheduledAlarm())).toBeNull();

    const invite = await SELF.fetch(`https://room.example.test/j/${inviteId}/${secret}`);
    expect(invite.status).toBe(404);
    expect(await invite.text()).not.toContain(secret);

    const page = await SELF.fetch(`https://room.example.test/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(404);
    await page.text();

    const api = await SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain(credential);

    const feed = await SELF.fetch(`https://room.example.test/rooms/${roomId}/feed`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(feed.status).toBe(404);
    await feed.text();

    const revoke = await SELF.fetch(`https://room.example.test/api/r/${roomId}/agents/${agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(revoke.status).toBe(404);
    await revoke.text();
  });
});
