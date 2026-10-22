import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { agentCookieName } from "../../src/room-page/routes.js";

const hostSecret = "host-test-secret";
const note = "Bring napkins";

describe("worker agent json api", () => {
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
    const joined = JSON.parse(openedText) as Joined;
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
      body: JSON.stringify({ text: note }),
    });
    expect(posted.status).toBe(201);
    expect(await posted.text()).toContain(note);
    const hits = await runInDurableObject(stub, (instance) => instance.postHitCount(joined.agentId));
    expect(hits).toBe(1);

    const read = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
      headers: { authorization: `Bearer ${joined.agentKey}` },
    });
    expect(await read.json()).toMatchObject({ posts: [{ text: note }] });

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
    const refusal = audit.find((row) => row.action === "post" && row.result === "refused");
    expect(refusal?.detailJson).toContain("429");
    expect(JSON.stringify(audit).includes(joined.agentKey)).toBe(false);
  }, 60_000);
});

interface Joined {
  agentId: string;
  agentKey: string;
  title: string;
}

async function hostRoom(title: string): Promise<{ roomId: string; id: string; secret: string; credential: string }> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({ title, hostName: "Host (demo)", inviteCount: 1 }),
  });
  const body = await response.text();
  expect(response.status).toBe(201);
  expect(body.includes(hostSecret)).toBe(false);
  const created = JSON.parse(body) as { invites?: string[]; roomId?: string; credential?: string };
  const link = created.invites?.[0] ?? "";
  const parts = new URL(link).pathname.split("/");
  return {
    roomId: created.roomId ?? "",
    id: parts[2] ?? "",
    secret: parts[3] ?? "",
    credential: created.credential ?? "",
  };
}
