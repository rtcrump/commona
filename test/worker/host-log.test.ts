import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";

describe("worker host owner log", () => {
  it("lets the owner read /log, refuses anyone else, and audits the token", async () => {
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
    expect(text.includes(hostSecret)).toBe(false);
    const created = JSON.parse(text) as {
      credential?: string;
      roomId?: string;
      ownerToken?: string;
      ownerId?: string;
      invites?: string[];
    };
    const ownerToken = created.ownerToken ?? "";
    const ownerId = created.ownerId ?? "";
    const credential = created.credential ?? "";
    expect(ownerId).toMatch(/^owner_[0-9a-f-]{36}$/);
    expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(ownerToken).not.toBe(credential);
    expect(created.roomId).toMatch(/^room_/);
    expect(text.includes(hashToken(ownerToken))).toBe(false);
    for (const link of created.invites ?? []) expect(link.includes(ownerToken)).toBe(false);

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const stored = await runInDurableObject(stub, (instance) => instance.ownerKeyState(ownerId));
    expect(stored?.tokenHash).toBe(hashToken(ownerToken));
    expect(JSON.stringify(stored).includes(ownerToken)).toBe(false);

    const rows = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const issued = rows.find(
      (row) => row.action === "setting_change" && row.detailJson === `{"itemId":"${ownerId}"}`,
    );
    expect(issued).toMatchObject({
      result: "ok",
      ownerId,
      agentId: `owner:${ownerId}`,
      room: created.roomId,
    });
    const auditText = JSON.stringify(rows);
    expect(auditText.includes(ownerToken)).toBe(false);
    expect(auditText.includes(credential)).toBe(false);
    expect(auditText.includes(hostSecret)).toBe(false);

    const log = await SELF.fetch(`https://room.example.test/log?owner=${encodeURIComponent(ownerId)}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const logText = await log.text();
    expect(log.status).toBe(200);
    const entries =
      (
        JSON.parse(logText) as {
          entries?: { action?: string; ownerId?: string; detail?: { itemId?: string } }[];
        }
      ).entries ?? [];
    expect(
      entries.some(
        (row) => row.action === "setting_change" && row.ownerId === ownerId && row.detail?.itemId === ownerId,
      ),
    ).toBe(true);
    expect(entries.every((row) => row.ownerId === ownerId)).toBe(true);
    expect(logText.includes(ownerToken)).toBe(false);
    expect(logText.includes(credential)).toBe(false);
    expect(logText.includes(hostSecret)).toBe(false);

    const missing = await SELF.fetch(`https://room.example.test/log?owner=${encodeURIComponent(ownerId)}`);
    expect(missing.status).toBe(401);
    expect((await missing.text()).includes(ownerToken)).toBe(false);

    const agent = await SELF.fetch(`https://room.example.test/log?owner=${encodeURIComponent(ownerId)}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const agentText = await agent.text();
    expect(agent.status).toBe(403);
    expect(agentText.includes(ownerToken)).toBe(false);
    expect(agentText.includes(credential)).toBe(false);
  });
});
