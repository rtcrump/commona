import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { agentCookieName } from "../../src/room-page/routes.js";

const hostSecret = "host-test-secret";
const TIME = "Tue 1pm";
const PLACE = "North cafe";
const NOTE = "Bring napkins";

describe("worker propose and agree", () => {
  it("returns a proposal id, keeps plain text, and marks the room done when every member agrees", async () => {
    const created = await hostRoom("Fake lunch room", 1, futureDeadline());
    const guest = await join(created);
    await grantMessages(created.ownerToken, created.roomId, created.ownerId, guest.ownerId);

    const plain = await post(created.roomId, created.credential, { text: NOTE });
    expect(plain.status).toBe(201);
    expect(await plain.json()).toMatchObject({ outcome: "accepted", post: { text: NOTE } });

    const proposed = await post(created.roomId, created.credential, {
      kind: "propose",
      time: TIME,
      place: PLACE,
      text: NOTE,
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as { proposalId?: string; kind?: string };
    expect(proposal.proposalId).toMatch(/^proposal_[0-9a-f-]{36}$/);
    expect(proposal.kind).toBe("propose");
    const proposalId = proposal.proposalId ?? "";

    const countered = await post(created.roomId, guest.agentKey, { kind: "counter", proposalId });
    expect(countered.status).toBe(201);
    expect(await countered.json()).toEqual({ outcome: "accepted", kind: "counter", proposalId });

    const guestAgrees = await post(created.roomId, guest.agentKey, { kind: "agree", proposalId });
    expect(guestAgrees.status).toBe(200);
    await guestAgrees.arrayBuffer();
    const hostAgrees = await post(created.roomId, created.credential, { kind: "agree", proposalId });
    expect(hostAgrees.status).toBe(201);

    for (const token of [created.credential, guest.agentKey]) {
      const read = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ status: "done", proposalId, time: TIME, place: PLACE });
      const feed = await SELF.fetch(`https://room.example.test/rooms/${created.roomId}/feed`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(feed.status).toBe(200);
      expect(await feed.json()).toMatchObject({ status: "done", time: TIME, place: PLACE });
    }

    const page = await SELF.fetch(`https://room.example.test/r/${created.roomId}`, {
      headers: { cookie: `${agentCookieName(created.roomId)}=${guest.agentKey}` },
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("This room is done.");
    expect(html).toContain(TIME);
    expect(html).toContain(PLACE);

    const closed = await post(created.roomId, guest.agentKey, { text: NOTE });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: { code: "validation", message: "This room is done." } });
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const refusal = audit.find((row) => row.action === "post" && row.result === "refused" && row.room === created.roomId);
    expect(refusal?.detailJson).toContain("409");
    expect(refusal?.detailJson).not.toContain(NOTE);
  });

  it("returns stalled from the brief deadline and rejects a bad agree", async () => {
    const created = await hostRoom("Fake stalled lunch", 1, futureDeadline());
    const guest = await join(created);
    const proposed = await post(created.roomId, guest.agentKey, {
      kind: "propose",
      time: TIME,
      place: PLACE,
      text: NOTE,
    });
    const proposalId = ((await proposed.json()) as { proposalId: string }).proposalId;

    const unknown = await post(created.roomId, created.credential, {
      kind: "agree",
      proposalId: "proposal_00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.status).toBe(400);
    await unknown.arrayBuffer();

    const other = await hostRoom("Other fake room", 1, futureDeadline());
    const cross = await post(other.roomId, other.credential, { kind: "agree", proposalId });
    expect(cross.status).toBe(400);
    await cross.arrayBuffer();

    const forged = await post(created.roomId, guest.agentKey, {
      kind: "agree",
      proposalId,
      ownerId: created.ownerId,
    });
    expect(forged.status).toBe(400);
    await forged.arrayBuffer();

    await setDeadline(created.roomId, "2000-01-01T00:00:00.000Z");
    for (const token of [created.credential, guest.agentKey]) {
      const read = await SELF.fetch(`https://room.example.test/api/r/${created.roomId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await read.json()) as {
        status?: string;
        proposals?: { proposalId: string; time: string; place: string; text: string }[];
      };
      expect(body.status).toBe("stalled");
      expect(body.proposals).toEqual([{ proposalId, time: TIME, place: PLACE, text: NOTE }]);
    }

    const stalled = await post(created.roomId, created.credential, { text: NOTE });
    expect(stalled.status).toBe(409);
    expect(await stalled.json()).toEqual({ error: { code: "validation", message: "This room is stalled." } });

    const page = await SELF.fetch(`https://room.example.test/r/${created.roomId}`, {
      headers: { cookie: `${agentCookieName(created.roomId)}=${guest.agentKey}` },
    });
    expect(await page.text()).toContain("This room is stalled.");
  });
});

async function post(roomId: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function join(
  created: { roomId: string; id: string; secret: string },
): Promise<{ agentKey: string; ownerId: string }> {
  const opened = await SELF.fetch(
    `https://room.example.test/api/r/${created.roomId}/${created.id}/${created.secret}`,
  );
  expect(opened.status).toBe(200);
  const body = (await opened.json()) as { agentKey?: string; ownerId?: string };
  expect(body.agentKey).toBeTruthy();
  expect(body.ownerId).toBeTruthy();
  return { agentKey: body.agentKey ?? "", ownerId: body.ownerId ?? "" };
}

async function grantMessages(token: string, roomId: string, fromOwnerId: string, toOwnerId: string): Promise<void> {
  const response = await SELF.fetch(`https://room.example.test/api/rooms/${roomId}/sharing`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fromOwnerId, toOwnerId, level: "messages" }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

function futureDeadline(): string {
  return new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
}

async function hostRoom(
  title: string,
  inviteCount: number,
  deadline: string,
): Promise<{ roomId: string; id: string; secret: string; credential: string; ownerId: string; ownerToken: string }> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({
      title,
      hostName: "Host (demo)",
      inviteCount,
      brief: {
        task: "Agree a pretend lunch",
        endCondition: "Everyone agrees one time and place",
        deadline,
      },
    }),
  });
  const text = await response.text();
  expect(response.status).toBe(201);
  const created = JSON.parse(text) as {
    invites?: string[];
    roomId?: string;
    credential?: string;
    ownerId?: string;
    ownerToken?: string;
  };
  const link = created.invites?.[0] ?? "";
  const parts = new URL(link).pathname.split("/");
  return {
    roomId: created.roomId ?? "",
    id: parts[2] ?? "",
    secret: parts[3] ?? "",
    credential: created.credential ?? "",
    ownerId: created.ownerId ?? "",
    ownerToken: created.ownerToken ?? "",
  };
}

async function setDeadline(roomId: string, deadline: string): Promise<void> {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
  await runInDurableObject(stub, (instance) => {
    const storage = instance.ctx.storage as {
      sql: { exec(query: string, ...bindings: unknown[]): unknown };
    };
    storage.sql.exec("UPDATE room_briefs SET deadline = ? WHERE room_id = ?", deadline, roomId);
  });
}
