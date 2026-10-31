import { afterEach, describe, expect, it } from "vitest";
import { SharingLevel, type SharingLevel as SharingLevelName } from "../../contract/index.js";
import { saveBrief } from "../../src/room/brief.js";
import type { RoomDeps } from "../../src/room/deps.js";
import { agentCookieName } from "../../src/room-page/routes.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const TIME = "Tue 1pm";
const PLACE = "North cafe";
const LATER = "Wed 2pm";
const OTHER_PLACE = "South park bench";

describe("propose, agree, and room status", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("accepts a proposal, an agree, a counter, and a plain text post", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[0] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");

    const proposed = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a1,
      json: { kind: "propose", time: TIME, place: PLACE, text: note },
    });
    expect(proposed.status).toBe(201);
    const proposalId = (JSON.parse(proposed.body) as { proposalId?: string }).proposalId ?? "";
    expect(proposalId).toMatch(/^proposal_[0-9a-f-]{36}$/);
    expect(JSON.parse(proposed.body)).toMatchObject({ outcome: "accepted", kind: "propose", proposalId });

    const countered = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a2,
      json: { kind: "counter", proposalId },
    });
    expect(countered.status).toBe(201);
    expect(JSON.parse(countered.body)).toEqual({ outcome: "accepted", kind: "counter", proposalId });

    const agreed = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a2,
      json: { kind: "agree", proposalId },
    });
    expect(agreed.status).toBe(200);
    expect(JSON.parse(agreed.body)).toEqual({ outcome: "accepted", kind: "agree", proposalId });

    const plain = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a1,
      json: { text: note },
    });
    expect(plain.status).toBe(201);
    expect(JSON.parse(plain.body)).toMatchObject({ outcome: "accepted", post: { text: note } });

    const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: a1 });
    expect(JSON.parse(read.body)).toMatchObject({ posts: expect.arrayContaining([{ text: note }]) });
  });

  it("returns done with the agreed time and place once every member agrees", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[1] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    shareMessages(room);
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);

    for (const token of [a1, a2]) {
      const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token });
      expect(JSON.parse(read.body)).toMatchObject({
        status: "done",
        proposalId,
        time: TIME,
        place: PLACE,
      });
      const feed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token });
      expect(JSON.parse(feed.body)).toMatchObject({ status: "done", proposalId, time: TIME, place: PLACE });
    }

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${a1}`,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("This room is done.");
    expect(page.body).toContain(TIME);
    expect(page.body).toContain(PLACE);
    expect(page.body).not.toMatch(/<script/i);

    room.clock.advance(31 * 60 * 1000);
    const later = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: a2 });
    expect(JSON.parse(later.body)).toMatchObject({ status: "done", time: TIME, place: PLACE });
  });

  it("returns stalled with the open proposals after the brief deadline", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[2] ?? "";
    const other = loadFixtures().normalMessages[3] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    shareMessages(room);
    const first = await propose(room, a1, TIME, PLACE, note);
    room.clock.advance(1);
    const second = await propose(room, a2, LATER, OTHER_PLACE, other);
    await agree(room, a1, first);

    const before = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: a2 });
    expect(JSON.parse(before.body)).toMatchObject({ status: "open" });

    room.clock.advance(30 * 60 * 1000);
    for (const token of [a1, a2]) {
      const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token });
      const body = JSON.parse(read.body) as { status?: string; proposals?: { proposalId: string; time: string; place: string; text: string }[] };
      expect(body.status).toBe("stalled");
      expect(body.proposals).toEqual([
        { proposalId: first, time: TIME, place: PLACE, text: note },
        { proposalId: second, time: LATER, place: OTHER_PLACE, text: other },
      ]);
      const feed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token });
      expect(JSON.parse(feed.body)).toMatchObject({ status: "stalled" });
    }

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
      cookie: `${agentCookieName(room.roomId)}=${a1}`,
    });
    expect(page.body).toContain("This room is stalled.");
    expect(page.body).toContain(TIME);
    expect(page.body).toContain(PLACE);
    expect(page.body).toContain(note);
  });

  it("returns 409 and audits posts after done or stalled", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[4] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);

    const donePost = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a1,
      json: { text: note },
    });
    expect(donePost.status).toBe(409);
    expect(JSON.parse(donePost.body)).toEqual({ error: { code: "validation", message: "This room is done." } });
    expect(refusals(room)).toBe(1);

    const stalled = await startJoinHarness();
    try {
      const stalledNote = loadFixtures().normalMessages[5] ?? "";
      const stalledAgents = agents(stalled);
      setBrief(stalled, "2026-04-01T12:30:00.000Z");
      await propose(stalled, stalledAgents.a1, TIME, PLACE, stalledNote);
      stalled.clock.advance(30 * 60 * 1000);
      const stalledPost = await call(stalled.baseUrl, "POST", `/api/r/${stalled.roomId}`, {
        token: stalledAgents.a2,
        json: { kind: "propose", time: LATER, place: OTHER_PLACE, text: stalledNote },
      });
      expect(stalledPost.status).toBe(409);
      expect(JSON.parse(stalledPost.body)).toEqual({
        error: { code: "validation", message: "This room is stalled." },
      });
      expect(refusals(stalled)).toBe(1);
      expect(auditText(stalled)).not.toContain(stalledNote);
    } finally {
      await stalled.stop();
    }
  });

  it("rejects an unknown proposal, a proposal from another room, and an agree for another owner", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[6] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    const proposalId = await propose(room, a1, TIME, PLACE, note);

    const unknown = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a2,
      json: { kind: "agree", proposalId: "proposal_00000000-0000-4000-8000-000000000000" },
    });
    expect(unknown.status).toBe(400);

    const owner = room.tokens.authenticate(room.owner);
    expect(owner?.kind).toBe("owner");
    const created = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, json: {} });
    const otherRoom = (JSON.parse(created.body) as { room: { id: string } }).room.id;
    const ownerTwo = room.tokens.issueOwnerToken("O2");
    await call(room.baseUrl, "POST", `/rooms/${otherRoom}/members`, { token: room.owner, json: { agentId: "A1" } });
    await call(room.baseUrl, "POST", `/rooms/${otherRoom}/members`, { token: ownerTwo, json: { agentId: "A2" } });
    const cross = await call(room.baseUrl, "POST", `/api/r/${otherRoom}`, {
      token: a2,
      json: { kind: "agree", proposalId },
    });
    expect(cross.status).toBe(400);

    const forged = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: a2,
      json: { kind: "agree", proposalId, ownerId: "O1" },
    });
    expect(forged.status).toBe(400);
    const row = room.db
      .prepare("SELECT agent_id, owner_id FROM proposal_responses WHERE proposal_id = ?")
      .all(proposalId) as { agent_id: string; owner_id: string }[];
    expect(row).toEqual([]);

    await agree(room, a1, proposalId);
    const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: a2 });
    expect(JSON.parse(read.body)).toMatchObject({ status: "open" });
    const stored = room.db
      .prepare("SELECT agent_id, owner_id FROM proposal_responses WHERE proposal_id = ?")
      .all(proposalId) as { agent_id: string; owner_id: string }[];
    expect(stored).toEqual([{ agent_id: "A1", owner_id: "O1" }]);
  });

  it("wipes proposals when the room is deleted", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[7] ?? "";
    const { a1, a2 } = agents(room);
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);
    expect(room.db.prepare("SELECT proposal_id FROM room_talk_done WHERE room_id = ?").get(room.roomId)).toEqual({
      proposal_id: proposalId,
    });
    expect(room.db.prepare("SELECT id FROM proposals WHERE room_id = ?").get(room.roomId)).toBeDefined();

    const deleted = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}`, { token: room.owner });
    expect(deleted.status).toBe(200);
    expect(room.db.prepare("SELECT id FROM proposals WHERE room_id = ?").get(room.roomId)).toBeUndefined();
    expect(
      room.db.prepare("SELECT proposal_id FROM proposal_responses WHERE room_id = ?").get(room.roomId),
    ).toBeUndefined();
    expect(room.db.prepare("SELECT room_id FROM room_talk_done WHERE room_id = ?").get(room.roomId)).toBeUndefined();
  });

  it("hides proposal content when the author shares none, and again after sharing is lowered", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[8] ?? "";
    const other = loadFixtures().normalMessages[9] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    room.clock.advance(1);
    const second = await propose(room, a2, LATER, OTHER_PLACE, other);

    await expectOpen(room, a2, [{ proposalId: second, time: LATER, place: OTHER_PLACE, text: other }], [
      TIME,
      PLACE,
      note,
      proposalId,
    ]);
    await expectOpen(room, a1, [{ proposalId, time: TIME, place: PLACE, text: note }], [
      LATER,
      OTHER_PLACE,
      other,
      second,
    ]);

    share(room, "O1", "O2", SharingLevel.Messages);
    share(room, "O2", "O1", SharingLevel.Messages);
    await expectOpen(
      room,
      a2,
      [
        { proposalId, time: TIME, place: PLACE, text: note },
        { proposalId: second, time: LATER, place: OTHER_PLACE, text: other },
      ],
      [],
    );

    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);
    await expectDone(room, a2, { proposalId, time: TIME, place: PLACE }, []);

    share(room, "O1", "O2", SharingLevel.None);
    await expectDone(room, a2, null, [TIME, PLACE, note, proposalId]);
    await expectDone(room, a1, { proposalId, time: TIME, place: PLACE }, []);
  });

  it("stays done when a member is added after everyone agreed", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[10] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);

    const ownerThree = room.tokens.issueOwnerToken("O3");
    const added = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/members`, {
      token: ownerThree,
      json: { agentId: "AX" },
    });
    expect(added.status).toBe(201);
    const axToken = (JSON.parse(added.body) as { token?: string }).token ?? "";
    expect(axToken.length).toBeGreaterThan(0);

    await expectDone(room, a1, { proposalId, time: TIME, place: PLACE }, []);
    await expectDone(room, axToken, null, [TIME, PLACE, note, proposalId]);
    await expectClosed(room, [a1, a2, axToken], note);

    room.clock.advance(31 * 60 * 1000);
    await expectDone(room, a1, { proposalId, time: TIME, place: PLACE }, []);
    const later = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, { token: axToken, json: { text: note } });
    expect(later.status).toBe(409);
    expect(JSON.parse(later.body)).toEqual({ error: { code: "validation", message: "This room is done." } });
  });

  it("stays done when an invite is redeemed after everyone agreed", async () => {
    room = await startJoinHarness();
    const note = loadFixtures().normalMessages[11] ?? "";
    const { a1, a2 } = agents(room);
    setBrief(room, "2026-04-01T12:30:00.000Z");
    const proposalId = await propose(room, a1, TIME, PLACE, note);
    await agree(room, a1, proposalId);
    await agree(room, a2, proposalId);

    const invite = await createInvite(room);
    const secret = invite.openPath.split("/")[3] ?? "";
    const redeemed = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}`);
    expect(redeemed.status).toBe(200);
    const body = JSON.parse(redeemed.body) as {
      agentKey?: string;
      status?: string;
      time?: string;
      place?: string;
      proposalId?: string;
    };
    expect(body.status).toBe("done");
    expect(body.time).toBeUndefined();
    expect(body.place).toBeUndefined();
    expect(body.proposalId).toBeUndefined();
    expect(redeemed.body).not.toContain(TIME);
    expect(redeemed.body).not.toContain(PLACE);
    expect(redeemed.body).not.toContain(note);
    const agentKey = body.agentKey ?? "";
    expect(agentKey.length).toBeGreaterThan(0);

    await expectDone(room, a1, { proposalId, time: TIME, place: PLACE }, []);
    await expectClosed(room, [agentKey], note);

    room.clock.advance(31 * 60 * 1000);
    await expectDone(room, a1, { proposalId, time: TIME, place: PLACE }, []);
    const later = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: a2 });
    const laterBody = JSON.parse(later.body) as { status?: string; time?: string };
    expect(laterBody.status).toBe("done");
    expect(laterBody.time).toBeUndefined();
  });
});

interface ProposalView {
  proposalId: string;
  time: string;
  place: string;
  text: string;
}

function share(room: JoinHarness, fromOwnerId: string, toOwnerId: string, level: SharingLevelName): void {
  const updated = room.sharing.update(
    { kind: "owner", ownerId: fromOwnerId },
    room.roomId,
    fromOwnerId,
    toOwnerId,
    level,
  );
  expect(updated.allowed).toBe(true);
}

function shareMessages(room: JoinHarness): void {
  share(room, "O1", "O2", SharingLevel.Messages);
  share(room, "O2", "O1", SharingLevel.Messages);
}

async function surfaces(room: JoinHarness, token: string): Promise<{ api: unknown; feed: unknown; html: string }> {
  const apiHit = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token });
  const feedHit = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token });
  const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, {
    cookie: `${agentCookieName(room.roomId)}=${token}`,
  });
  expect(apiHit.status).toBe(200);
  expect(feedHit.status).toBe(200);
  expect(page.status).toBe(200);
  return { api: JSON.parse(apiHit.body), feed: JSON.parse(feedHit.body), html: page.body };
}

async function expectOpen(
  room: JoinHarness,
  token: string,
  proposals: ProposalView[],
  hidden: readonly string[],
): Promise<void> {
  const seen = await surfaces(room, token);
  expect(seen.api).toMatchObject({ status: "open", proposals });
  expect(seen.feed).toMatchObject({ status: "open", proposals });
  expect(seen.html).toContain("This room is still open.");
  for (const proposal of proposals) {
    expect(seen.html).toContain(proposal.time);
    expect(seen.html).toContain(proposal.place);
    expect(seen.html).toContain(proposal.text);
  }
  const packed = JSON.stringify(seen.api) + JSON.stringify(seen.feed) + seen.html;
  for (const secret of hidden) expect(packed).not.toContain(secret);
}

async function expectDone(
  room: JoinHarness,
  token: string,
  visible: { proposalId: string; time: string; place: string } | null,
  hidden: readonly string[],
): Promise<void> {
  const seen = await surfaces(room, token);
  const api = seen.api as { status?: string };
  const feed = seen.feed as { status?: string };
  expect(api.status).toBe("done");
  expect(feed.status).toBe("done");
  if (visible) {
    expect(seen.api).toMatchObject({ status: "done", ...visible });
    expect(seen.feed).toMatchObject({ status: "done", ...visible });
    expect(seen.html).toContain("The agreed time is");
    expect(seen.html).toContain(visible.time);
    expect(seen.html).toContain(visible.place);
  } else {
    expect(seen.api).not.toHaveProperty("time");
    expect(seen.api).not.toHaveProperty("place");
    expect(seen.api).not.toHaveProperty("proposalId");
    expect(seen.api).not.toHaveProperty("proposals");
    expect(seen.feed).not.toHaveProperty("time");
    expect(seen.feed).not.toHaveProperty("place");
    expect(seen.feed).not.toHaveProperty("proposalId");
    expect(seen.html).toContain("This room is done.");
    expect(seen.html).not.toContain("The agreed time is");
  }
  const packed = JSON.stringify(seen.api) + JSON.stringify(seen.feed) + seen.html;
  for (const secret of hidden) expect(packed).not.toContain(secret);
}

async function expectClosed(room: JoinHarness, tokens: readonly string[], note: string): Promise<void> {
  for (const token of tokens) {
    const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, { token, json: { text: note } });
    expect(posted.status).toBe(409);
    expect(JSON.parse(posted.body)).toEqual({ error: { code: "validation", message: "This room is done." } });
  }
}

function agents(room: JoinHarness): { a1: string; a2: string } {
  return {
    a1: room.tokens.issueAgentToken("A1"),
    a2: room.tokens.issueAgentToken("A2"),
  };
}

function setBrief(room: JoinHarness, deadline: string): void {
  saveBrief({ db: room.db } as RoomDeps, room.roomId, {
    task: "Agree a pretend lunch",
    endCondition: "Everyone agrees one time and place",
    deadline,
  });
}

async function propose(room: JoinHarness, token: string, time: string, place: string, text: string): Promise<string> {
  const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
    token,
    json: { kind: "propose", time, place, text },
  });
  expect(posted.status).toBe(201);
  return (JSON.parse(posted.body) as { proposalId: string }).proposalId;
}

async function agree(room: JoinHarness, token: string, proposalId: string): Promise<void> {
  const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
    token,
    json: { kind: "agree", proposalId },
  });
  expect(posted.status).toBe(201);
  expect(JSON.parse(posted.body)).toMatchObject({ outcome: "accepted", kind: "agree", proposalId });
}

function refusals(room: JoinHarness): number {
  const row = room.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'post' AND result = 'refused'")
    .get() as { n: number };
  return Number(row.n);
}

function auditText(room: JoinHarness): string {
  const rows = room.db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
  return rows.map((row) => row.detail_json).join("\n");
}
