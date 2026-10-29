import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { NEW_AGENT_NAME } from "../../src/onboarding/account.js";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

/** Fictional room note. Not a person, and not a patient record. */
const NOTE = "Bring cups";

describe("link join display name", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("sets the name from the join link, shows it on the feed and members, and records it", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const opened = await call(room.baseUrl, "GET", `/api${invite.openPath}?name=%20Riley%20`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.displayName).toBe("Riley");
    expect(joined.naming).toContain("?name=");
    expect(joined.naming).toContain("addresses.name");
    expect(joined.addresses.name).toEqual({
      method: "PUT",
      url: `${room.baseUrl}/api/r/${joined.roomId}/name`,
    });
    expect(agentName(room, joined.agentId)).toBe("Riley");

    const posted = await call(room.baseUrl, "POST", `/api/r/${joined.roomId}`, {
      token: joined.agentKey,
      json: { text: NOTE },
    });
    expect(posted.status).toBe(201);
    const feed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/feed`, { token: agentToken(room, "A1") });
    expect(feed.status).toBe(200);
    expect(JSON.parse(feed.body).items).toContainEqual(expect.objectContaining({ text: NOTE, authorName: "Riley" }));
    const listed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/members`, { token: agentToken(room, "A1") });
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).members).toContainEqual(
      expect.objectContaining({ agentId: joined.agentId, displayName: "Riley" }),
    );
    expect(joinDetail(room, joined.agentId).displayName).toBe("Riley");
  });

  it("joins without a name and keeps New Agent", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const opened = await call(room.baseUrl, "GET", `/api${invite.openPath}`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.displayName).toBe(NEW_AGENT_NAME);
    expect(joined.naming).toContain("New Agent");
    expect(joined.addresses.name.method).toBe("PUT");
    expect(agentName(room, joined.agentId)).toBe(NEW_AGENT_NAME);
    expect(joinDetail(room, joined.agentId).displayName).toBeUndefined();

    const posted = await call(room.baseUrl, "POST", `/api/r/${joined.roomId}`, {
      token: joined.agentKey,
      json: { text: NOTE },
    });
    expect(posted.status).toBe(201);
    const feed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/feed`, { token: joined.agentKey });
    expect(JSON.parse(feed.body).items).toContainEqual(
      expect.objectContaining({ text: NOTE, authorName: NEW_AGENT_NAME }),
    );
    const listed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/members`, { token: joined.agentKey });
    expect(JSON.parse(listed.body).members).toContainEqual(
      expect.objectContaining({ agentId: joined.agentId, displayName: NEW_AGENT_NAME }),
    );
  });

  it.each([
    ["empty", "name="],
    ["blank", "name=%20%20"],
    ["too long", `name=${"R".repeat(41)}`],
    ["digit", "name=Riley2"],
    ["markup", "name=%3CRiley%3E"],
    ["newline", "name=Riley%0ALee"],
    ["two values", "name=Riley&name=Quinn"],
  ])("rejects a %s name without using the invite", async (_label, query) => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const before = counts(room);
    const refused = await call(room.baseUrl, "GET", `/api${invite.openPath}?${query}`);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: { code: "validation", message: "Invalid request." } });
    expect(refused.body).not.toContain("Riley");
    expect(refused.body).not.toContain("Quinn");
    expect(counts(room)).toEqual(before);
    expect(usedAt(room, invite.id)).toBeNull();
    expect(auditText(room)).not.toContain("Riley");
    expect(auditText(room)).not.toContain("Quinn");
  });

  it("rejects a blocked name without using the invite, then still joins without one", async () => {
    room = await startJoinHarness();
    const blocked = listedName();
    const invite = await createInvite(room);
    const before = counts(room);
    const refused = await call(room.baseUrl, "GET", `/api${invite.openPath}?name=${encodeURIComponent(blocked)}`);
    expect(refused.status).toBe(400);
    expect(refused.body).not.toContain(blocked);
    expect(counts(room)).toEqual(before);
    expect(usedAt(room, invite.id)).toBeNull();
    expect(auditText(room)).not.toContain(blocked);

    const opened = await call(room.baseUrl, "GET", `/api${invite.openPath}`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.displayName).toBe(NEW_AGENT_NAME);
    expect(opened.body).not.toContain(blocked);
    expect(auditText(room)).not.toContain(blocked);
  });

  it("accepts the name on the room-id join route", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/").at(-1) ?? "";
    const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}?name=Anne-Marie`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.displayName).toBe("Anne-Marie");
    expect(agentName(room, joined.agentId)).toBe("Anne-Marie");
    expect(joinDetail(room, joined.agentId).displayName).toBe("Anne-Marie");
  });

  it("lets only that agent rename itself, and the feed and members follow", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const opened = await call(room.baseUrl, "GET", `/api${invite.openPath}?name=Riley`);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    const path = `/api/r/${joined.roomId}/name`;
    expect(joined.addresses.name.url).toBe(`${room.baseUrl}${path}`);

    const owner = await call(room.baseUrl, "PUT", path, { token: room.owner, json: { name: "Pat" } });
    expect(owner.status).toBe(401);
    const sharing = await call(room.baseUrl, "PUT", path, { token: joined.sharingKey, json: { name: "Pat" } });
    expect(sharing.status).toBe(401);
    const other = await call(room.baseUrl, "PUT", path, {
      token: agentToken(room, "A1"),
      json: { name: "Pat", agentId: joined.agentId },
    });
    expect(other.status).toBe(403);
    expect(other.body).not.toContain("Pat");
    expect(agentName(room, joined.agentId)).toBe("Riley");
    expect(agentName(room, "A1")).toBe("Agent One");
    expect(auditText(room)).not.toContain("Pat");

    const renamed = await call(room.baseUrl, "PUT", path, {
      token: joined.agentKey,
      json: { name: "  Quinn " },
    });
    expect(renamed.status).toBe(200);
    expect(JSON.parse(renamed.body)).toEqual({ displayName: "Quinn" });
    expect(agentName(room, joined.agentId)).toBe("Quinn");
    expect(agentName(room, "A1")).toBe("Agent One");

    const posted = await call(room.baseUrl, "POST", `/api/r/${joined.roomId}`, {
      token: joined.agentKey,
      json: { text: NOTE },
    });
    expect(posted.status).toBe(201);
    const feed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/feed`, { token: agentToken(room, "A1") });
    expect(JSON.parse(feed.body).items).toContainEqual(expect.objectContaining({ text: NOTE, authorName: "Quinn" }));
    const listed = await call(room.baseUrl, "GET", `/rooms/${joined.roomId}/members`, { token: agentToken(room, "A1") });
    expect(JSON.parse(listed.body).members).toContainEqual(
      expect.objectContaining({ agentId: joined.agentId, displayName: "Quinn" }),
    );
    const change = room.db
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'setting_change' AND agent_id = ?")
      .all(joined.agentId) as { detail_json: string }[];
    expect(change.some((row) => JSON.parse(row.detail_json).displayName === "Quinn")).toBe(true);

    const bad = await call(room.baseUrl, "PUT", path, { token: joined.agentKey, json: { name: "Quinn 2" } });
    expect(bad.status).toBe(400);
    expect(agentName(room, joined.agentId)).toBe("Quinn");
    expect(auditText(room)).not.toContain("Quinn 2");
  });
});

interface Joined {
  roomId: string;
  agentId: string;
  agentKey: string;
  sharingKey: string;
  displayName: string;
  naming: string;
  addresses: { name: { method: string; url: string } };
}

function listedName(): string {
  const text = readFileSync(new URL("../../fixtures/names.txt", import.meta.url), "utf8");
  const name = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!name) throw new Error("fixtures/names.txt has no name");
  return name;
}

function agentToken(room: JoinHarness, agentId: string): string {
  for (const item of room.issued) {
    if (item.kind !== "agent") continue;
    const principal = room.tokens.authenticate(item.token);
    if (principal?.kind === "agent" && principal.agentId === agentId) return item.token;
  }
  throw new Error(`no token for ${agentId}`);
}

function agentName(room: JoinHarness, agentId: string): string {
  const row = room.db.prepare("SELECT display_name FROM agents WHERE id = ?").get(agentId) as
    | { display_name: string }
    | undefined;
  if (!row) throw new Error(`no agent ${agentId}`);
  return row.display_name;
}

function joinDetail(room: JoinHarness, agentId: string): { displayName?: string } {
  const row = room.db
    .prepare("SELECT detail_json FROM audit_log WHERE action = 'join' AND agent_id = ?")
    .get(agentId) as { detail_json: string };
  return JSON.parse(row.detail_json) as { displayName?: string };
}

function usedAt(room: JoinHarness, inviteId: string): string | null {
  const row = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(inviteId) as { used_at: string | null };
  return row.used_at;
}

function counts(room: JoinHarness): { agents: number; owners: number; memberships: number } {
  const count = (table: string) =>
    (room.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { agents: count("agents"), owners: count("owners"), memberships: count("memberships") };
}

function auditText(room: JoinHarness): string {
  return JSON.stringify(room.db.prepare("SELECT detail_json, action, result FROM audit_log").all());
}
