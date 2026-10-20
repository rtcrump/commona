import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";

interface CreatedRoom {
  roomId: string;
  credential: string;
  agentId: string;
  inviteId: string;
  secret: string;
}

describe("worker room delete", () => {
  it("returns 404 when the same agent polls again inside 30 seconds after the delete", async () => {
    const room = await createHostRoom("Host (demo)");
    const first = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/feed`, {
      headers: { authorization: `Bearer ${room.credential}` },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).not.toContain(room.credential);

    const deleted = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${room.credential}` },
    });
    expect(deleted.status).toBe(200);
    await deleted.text();

    const again = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/feed`, {
      headers: { authorization: `Bearer ${room.credential}` },
    });
    expect(again.status).toBe(404);
    const body = await again.text();
    expect(body).not.toContain(room.credential);
    expect(body).not.toContain(room.secret);

    const posted = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${room.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "A note after the room is gone." }),
    });
    expect(posted.status).toBe(404);
    expect(await posted.text()).not.toContain(room.credential);
  });

  it("refuses a missing token and a token that is not the owner", async () => {
    const room = await createHostRoom("Host (demo)");
    const stranger = await createHostRoom("Guest (demo)");
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    await runInDurableObject(directory, (instance) => alarmStorage(instance).setAlarm(Date.now() + 60_000));

    const missing = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}`, { method: "DELETE" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid token." } });

    const unknown = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.text();
    expect(unknownBody).not.toContain(room.secret);
    expect(unknownBody).not.toContain(room.credential);
    expect(unknownBody).not.toContain(hostSecret);

    const denied = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${stranger.credential}` },
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(JSON.parse(deniedBody)).toEqual({
      error: { code: "forbidden", message: "Not allowed.", reason: "not_owner" },
    });
    expect(deniedBody).not.toContain(room.secret);
    expect(deniedBody).not.toContain(room.credential);
    expect(deniedBody).not.toContain(stranger.credential);
    expect(deniedBody).not.toContain(hostSecret);

    const rows = await runInDurableObject(directory, (instance) => instance.auditSnapshot());
    const refusal = rows.find((row) => row.action === "setting_change_refused" && row.room === room.roomId);
    expect(refusal).toMatchObject({
      result: "refused",
      agentId: stranger.agentId,
      detailJson: JSON.stringify({ itemId: room.roomId, reasonCode: "not_owner" }),
    });
    expect(JSON.stringify(rows)).not.toContain(room.credential);
    expect(JSON.stringify(rows)).not.toContain(stranger.credential);
    expect(await runInDurableObject(directory, (instance) => alarmStorage(instance).getAlarm())).not.toBeNull();
    expect(await runInDurableObject(directory, (instance) => instance.inviteRecord(room.inviteId))).not.toBeNull();

    const deleted = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${room.credential}` },
    });
    const deletedText = await deleted.text();
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(deletedText) as {
      deleted?: boolean;
      audit?: { action?: string; result?: string; room?: string; ownerId?: string; agentId?: string; detail?: { itemId?: string }; hash?: string };
    };
    expect(body.deleted).toBe(true);
    expect(body.audit).toMatchObject({
      action: "setting_change",
      result: "ok",
      room: room.roomId,
      agentId: room.agentId,
      detail: { itemId: room.roomId },
    });
    expect(body.audit?.ownerId).toMatch(/^owner_/);
    expect(body.audit?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(deletedText).not.toContain(room.credential);
    expect(deletedText).not.toContain(room.secret);

    const after = await runInDurableObject(directory, (instance) => instance.auditSnapshot());
    expect(after.some((row) => row.action === "setting_change" && row.room === room.roomId && row.result === "ok")).toBe(
      true,
    );
    expect(after.some((row) => row.action === "setting_change_refused" && row.room === room.roomId)).toBe(true);
    expect(await runInDurableObject(directory, (instance) => instance.inviteRecord(room.inviteId))).toBeNull();
    expect(await runInDurableObject(directory, (instance) => instance.inviteRecord(stranger.inviteId))).not.toBeNull();
    expect(await runInDurableObject(directory, (instance) => alarmStorage(instance).getAlarm())).not.toBeNull();

    await expectGone(room);
    const stillThere = await SELF.fetch(`https://room.example.test/j/${stranger.inviteId}/${stranger.secret}`);
    expect(stillThere.status).toBe(200);
    expect(await stillThere.text()).not.toContain(stranger.secret);
  });
});

function alarmStorage(instance: { ctx: { storage: unknown } }): {
  setAlarm(ms: number): Promise<void>;
  getAlarm(): Promise<number | null>;
} {
  return instance.ctx.storage as {
    setAlarm(ms: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
}

async function expectGone(room: CreatedRoom): Promise<void> {
  const invite = await SELF.fetch(`https://room.example.test/j/${room.inviteId}/${room.secret}`);
  expect(invite.status).toBe(404);
  expect(await invite.text()).not.toContain(room.secret);

  const invitePage = await SELF.fetch(`https://room.example.test/j/${room.inviteId}/${room.secret}`, {
    headers: { accept: "text/html" },
  });
  expect(invitePage.status).toBe(404);
  expect(await invitePage.text()).not.toContain(room.secret);

  const page = await SELF.fetch(`https://room.example.test/r/${room.roomId}`);
  expect(page.status).toBe(404);
  expect(await page.text()).not.toContain(room.secret);

  const pageInvite = await SELF.fetch(`https://room.example.test/r/${room.roomId}/${room.inviteId}/${room.secret}`);
  expect(pageInvite.status).toBe(404);
  await pageInvite.text();

  const api = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}`, {
    headers: { authorization: `Bearer ${room.credential}` },
  });
  expect(api.status).toBe(404);
  expect(await api.text()).not.toContain(room.credential);

  const apiInvite = await SELF.fetch(
    `https://room.example.test/api/r/${room.roomId}/${room.inviteId}/${room.secret}`,
  );
  expect(apiInvite.status).toBe(404);
  expect(await apiInvite.text()).not.toContain(room.secret);

  const feed = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/feed`, {
    headers: { authorization: `Bearer ${room.credential}` },
  });
  expect(feed.status).toBe(404);
  await feed.text();

  const revoke = await SELF.fetch(`https://room.example.test/api/r/${room.roomId}/agents/${room.agentId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${room.credential}` },
  });
  expect(revoke.status).toBe(404);
  await revoke.text();
}

async function createHostRoom(hostName: string): Promise<CreatedRoom> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({ title: "Sunday lunch", hostName, inviteCount: 1 }),
  });
  const text = await response.text();
  expect(response.status).toBe(201);
  expect(text).not.toContain(hostSecret);
  const created = JSON.parse(text) as {
    invites?: string[];
    credential?: string;
    roomId?: string;
    agentId?: string;
  };
  const link = created.invites?.[0] ?? "";
  const parts = new URL(link).pathname.split("/");
  const inviteId = parts[2] ?? "";
  const secret = parts[3] ?? "";
  expect(created.roomId).toMatch(/^room_/);
  expect(created.credential).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(created.agentId).toMatch(/^agent_/);
  expect(inviteId).toMatch(/^inv_/);
  expect(secret.length).toBeGreaterThan(20);
  return {
    roomId: created.roomId ?? "",
    credential: created.credential ?? "",
    agentId: created.agentId ?? "",
    inviteId,
    secret,
  };
}
