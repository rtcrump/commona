import type { Clock, TokenStore } from "../../contract/index.js";
import { hashToken, SharingLevel } from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { buildApp } from "../../src/app.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { setInviteLog } from "../../src/join/log.js";
import { claimAgentHandoff, HANDOFF_TTL_MS, issueAgentHandoff } from "../../src/onboarding/handoff.js";
import { createSharingDirectory } from "../../src/sharing/index.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";
import { afterEach, describe, expect, it } from "vitest";

const GENERIC = { error: { code: "forbidden", message: "Not allowed." } };
const FIXTURE_NAMES = ["Owner One", "Owner Two", "Outsider Owner", "Agent One", "Agent Two", "Outsider Agent"];

interface Hit {
  status: number;
  bodyText: string;
  headers: [string, string][];
  setCookies: string[];
}

interface Issued {
  kind: "owner" | "agent";
  token: string;
}

function manualClock(start = "2026-04-01T12:00:00.000Z"): Clock & { advance(ms: number): void } {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advance(by: number) {
      ms += by;
    },
  };
}

function cookieValue(header: string, name: string): string | null {
  const prefix = `${name}=`;
  if (!header.startsWith(prefix)) return null;
  const end = header.indexOf(";");
  return header.slice(prefix.length, end === -1 ? undefined : end);
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown } = {},
): Promise<Hit> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const bodyText = await response.text();
  const setCookies = response.headers.getSetCookie();
  const listed: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") listed.push([name, value]);
  });
  return { status: response.status, bodyText, headers: listed, setCookies };
}

function json(hit: Hit): unknown {
  return JSON.parse(hit.bodyText) as unknown;
}

function inviteSecret(hit: Hit): string {
  const header = hit.setCookies.find((value) => value.startsWith("commona_invite="));
  expect(header, hit.bodyText).toBeTruthy();
  expect(header).toMatch(/HttpOnly/i);
  expect(header).toMatch(/Secure/i);
  expect(header).toMatch(/SameSite=Strict/i);
  const value = cookieValue(header ?? "", "commona_invite");
  expect(value).toBeTruthy();
  return value ?? "";
}

function sessionToken(hit: Hit): string {
  const header = hit.setCookies.find((value) => value.startsWith("commona_session="));
  expect(header).toBeTruthy();
  expect(header).toMatch(/HttpOnly/i);
  expect(header).toMatch(/Secure/i);
  expect(header).toMatch(/SameSite=Strict/i);
  const value = cookieValue(header ?? "", "commona_session");
  expect(value).toBeTruthy();
  return value ?? "";
}

function dumpDatabase(db: ReturnType<typeof openDatabase>): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const parts: string[] = [];
  for (const table of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(table.name)) continue;
    parts.push(JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all()));
  }
  return parts.join("\n");
}

function publicBlobs(hits: Hit[], logs: string[], auditJson: string): string[] {
  const blobs = [...logs, auditJson];
  for (const hit of hits) {
    blobs.push(hit.bodyText);
    for (const [name, value] of hit.headers) blobs.push(`${name}: ${value}`);
    for (const cookie of hit.setCookies) {
      if (cookie.startsWith("commona_invite=")) continue;
      blobs.push(cookie);
    }
  }
  return blobs;
}

function assertAbsent(blobs: string[], secrets: string[]): void {
  const haystack = blobs.join("\n");
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(20);
    expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(hashToken(secret));
  }
}

async function openHarness(clock: Clock & { advance(ms: number): void }) {
  const db = openDatabase(":memory:");
  seedFixtures(db, loadFixtures());
  const inner = createTokenStore(db);
  const issued: Issued[] = [];
  const tokens: TokenStore = {
    issueOwnerToken(ownerId: string) {
      const token = inner.issueOwnerToken(ownerId);
      issued.push({ kind: "owner", token });
      return token;
    },
    issueAgentToken(agentId: string) {
      const token = inner.issueAgentToken(agentId);
      issued.push({ kind: "agent", token });
      return token;
    },
    authenticate: (token: string) => inner.authenticate(token),
  };
  const audit = createAuditLog(db, clock);
  const sharing = createSharingDirectory(db);
  const logs: string[] = [];
  setInviteLog((line) => logs.push(line));
  const app = buildApp({ db, clock, tokens, audit, sharing });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("invite server did not bind");
  const owner = tokens.issueOwnerToken("O1");
  const created = await call(`http://127.0.0.1:${address.port}`, "POST", "/rooms", { token: owner, body: {} });
  const roomId = (json(created) as { room: { id: string } }).room.id;
  await call(`http://127.0.0.1:${address.port}`, "POST", `/rooms/${roomId}/members`, {
    token: owner,
    body: { agentId: "A1" },
  });
  const ownerTwo = tokens.issueOwnerToken("O2");
  await call(`http://127.0.0.1:${address.port}`, "POST", `/rooms/${roomId}/members`, {
    token: ownerTwo,
    body: { agentId: "A2" },
  });
  const outsider = tokens.issueOwnerToken("O3");
  return {
    db,
    clock,
    tokens,
    audit,
    sharing,
    logs,
    issued,
    baseUrl: `http://127.0.0.1:${address.port}`,
    roomId,
    owner,
    ownerTwo,
    outsider,
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}

describe.sequential("invite links", () => {
  afterEach(() => {
    setInviteLog(() => {});
  });

  it("creates an owner, agent, and membership at sharing None without rendering a secret", async () => {
    const clock = manualClock();
    const room = await openHarness(clock);
    const hits: Hit[] = [];
    const mark = room.issued.length;
    try {
      const created = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: {},
      });
      hits.push(created);
      expect(created.status).toBe(201);
      const createdBody = json(created) as { invite: { id: string; link: string; expiresAt: string } };
      expect(createdBody.invite.link).toBe(`${room.baseUrl}/j/${createdBody.invite.id}`);
      expect(new URL(createdBody.invite.link).search).toBe("");
      const stored = room.db
        .prepare("SELECT created_at, expires_at, secret_hash FROM invites WHERE id = ?")
        .get(createdBody.invite.id) as { created_at: string; expires_at: string; secret_hash: string };
      expect(Date.parse(stored.expires_at) - Date.parse(stored.created_at)).toBe(24 * 60 * 60 * 1000);

      const firstGet = await call(room.baseUrl, "GET", `/j/${createdBody.invite.id}`);
      hits.push(firstGet);
      expect(firstGet.status).toBe(200);
      expect(json(firstGet)).toEqual({ ok: true });
      const secret = inviteSecret(firstGet);
      expect(stored.secret_hash).toBe(hashToken(secret));
      expect(firstGet.bodyText).not.toContain(secret);

      const secondGet = await call(room.baseUrl, "GET", `/j/${createdBody.invite.id}`);
      hits.push(secondGet);
      expect(secondGet.setCookies.some((value) => value.startsWith("commona_invite="))).toBe(false);
      expect(json(secondGet)).toEqual({ ok: true });

      const accepted = await call(room.baseUrl, "POST", `/j/${createdBody.invite.id}/accept`, {
        cookie: `commona_invite=${secret}`,
        body: {},
      });
      hits.push(accepted);
      expect(accepted.status).toBe(201);
      const acceptedBody = json(accepted) as {
        owner: { id: string; displayName: string };
        agent: { id: string; displayName: string };
        member: { roomId: string; agentId: string; ownerId: string };
        sharing: string;
      };
      expect(acceptedBody.sharing).toBe(SharingLevel.None);
      expect(acceptedBody.owner.displayName).toBe("New Owner");
      expect(acceptedBody.agent.displayName).toBe("New Agent");
      expect(acceptedBody.member).toMatchObject({
        roomId: room.roomId,
        agentId: acceptedBody.agent.id,
        ownerId: acceptedBody.owner.id,
      });
      expect(acceptedBody).not.toHaveProperty("token");
      expect(accepted.bodyText.toLowerCase()).not.toContain("token");
      const session = sessionToken(accepted);
      expect(room.tokens.authenticate(session)).toEqual({ kind: "owner", ownerId: acceptedBody.owner.id });
      expect(room.sharing.level(room.roomId, "O1", acceptedBody.owner.id)).toBe(SharingLevel.None);
      expect(room.sharing.level(room.roomId, acceptedBody.owner.id, "O1")).toBe(SharingLevel.None);
      expect(room.sharing.level(room.roomId, "O2", acceptedBody.owner.id)).toBe(SharingLevel.None);

      const membership = room.db
        .prepare("SELECT agent_id, owner_id FROM memberships WHERE room_id = ? AND agent_id = ?")
        .get(room.roomId, acceptedBody.agent.id) as { agent_id: string; owner_id: string };
      expect(membership).toEqual({ agent_id: acceptedBody.agent.id, owner_id: acceptedBody.owner.id });
      const agentRow = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(acceptedBody.agent.id) as {
        token_hash: string;
      };
      const flow = room.issued.slice(mark);
      const credential = flow.find((item) => item.kind === "agent")?.token ?? "";
      expect(agentRow.token_hash).toBe(hashToken(credential));
      expect(room.tokens.authenticate(credential)).toEqual({
        kind: "agent",
        ownerId: acceptedBody.owner.id,
        agentId: acceptedBody.agent.id,
      });

      const reused = await call(room.baseUrl, "POST", `/j/${createdBody.invite.id}/accept`, {
        cookie: `commona_invite=${secret}`,
        body: {},
      });
      hits.push(reused);
      expect(reused.status).toBe(403);
      expect(json(reused)).toEqual(GENERIC);

      const handoffDeps = { db: room.db, clock, tokens: room.tokens };
      const handoff = issueAgentHandoff(handoffDeps, acceptedBody.owner.id);
      expect(Date.parse(handoff.expiresAt) - clock.now().getTime()).toBe(HANDOFF_TTL_MS);
      const claimed = claimAgentHandoff(handoffDeps, handoff.secret);
      expect(claimed.agentId).toBe(acceptedBody.agent.id);
      expect(room.tokens.authenticate(claimed.credential)).toEqual({
        kind: "agent",
        ownerId: acceptedBody.owner.id,
        agentId: acceptedBody.agent.id,
      });
      expect(() => claimAgentHandoff(handoffDeps, handoff.secret)).toThrow(/unusable/);
      const expiredHandoff = issueAgentHandoff(handoffDeps, acceptedBody.owner.id);
      clock.advance(HANDOFF_TTL_MS);
      expect(() => claimAgentHandoff(handoffDeps, expiredHandoff.secret)).toThrow(/unusable/);

      const inviteCols = room.db.prepare("PRAGMA table_info(invites)").all() as { name: string }[];
      expect(inviteCols.map((col) => col.name)).toContain("secret_hash");
      expect(inviteCols.map((col) => col.name)).not.toContain("secret");
      const dump = dumpDatabase(room.db);
      const rawSecrets = [secret, credential, handoff.secret, expiredHandoff.secret, claimed.credential, session];
      for (const value of rawSecrets) expect(dump).not.toContain(value);
      expect(dump).toContain(hashToken(secret));
      expect(dump).toContain(hashToken(claimed.credential));
      expect(dump).toContain(hashToken(handoff.secret));

      const auditJson = JSON.stringify(
        room.db.prepare("SELECT room, agent_id, owner_id, action, result, detail_json FROM audit_log").all(),
      );
      assertAbsent(publicBlobs(hits, room.logs, auditJson), [
        secret,
        credential,
        handoff.secret,
        expiredHandoff.secret,
        claimed.credential,
      ]);
      const sessionBlobs = [
        ...hits.map((hit) => hit.bodyText),
        ...hits.flatMap((hit) => hit.headers.map(([name, value]) => `${name}: ${value}`)),
        ...room.logs,
        auditJson,
      ];
      expect(sessionBlobs.join("\n")).not.toContain(session);
      expect(room.logs.length).toBeGreaterThan(0);
      expect(auditJson).toContain("setting_change");
      expect(auditJson).toContain("join");
      expect(auditJson).toContain(createdBody.invite.id);
      expect(room.audit.verify().ok).toBe(true);
    } finally {
      await room.stop();
    }
  });

  it("refuses expired, reused, revoked, wrong room, malformed, and non-member with one message", async () => {
    const clock = manualClock();
    const room = await openHarness(clock);
    const hits: Hit[] = [];
    const secrets: string[] = [];
    const mark = room.issued.length;
    try {
      const ownersBefore = (room.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n;

      const expiredCreate = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: { expiresInSeconds: 60 },
      });
      hits.push(expiredCreate);
      const expiredId = (json(expiredCreate) as { invite: { id: string } }).invite.id;
      const expiredGet = await call(room.baseUrl, "GET", `/j/${expiredId}`);
      hits.push(expiredGet);
      const expiredSecret = inviteSecret(expiredGet);
      secrets.push(expiredSecret);
      const expiredRow = room.db.prepare("SELECT created_at, expires_at FROM invites WHERE id = ?").get(expiredId) as {
        created_at: string;
        expires_at: string;
      };
      expect(Date.parse(expiredRow.expires_at) - Date.parse(expiredRow.created_at)).toBe(60_000);
      clock.advance(60_000);
      const expired = await call(room.baseUrl, "POST", `/j/${expiredId}/accept`, {
        cookie: `commona_invite=${expiredSecret}`,
        body: {},
      });
      hits.push(expired);

      const replayCreate = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: {},
      });
      hits.push(replayCreate);
      const replayId = (json(replayCreate) as { invite: { id: string } }).invite.id;
      const replayGet = await call(room.baseUrl, "GET", `/j/${replayId}`);
      hits.push(replayGet);
      const replaySecret = inviteSecret(replayGet);
      secrets.push(replaySecret);
      const replay = await call(room.baseUrl, "POST", `/j/${replayId}/accept`, {
        cookie: `commona_invite=${replaySecret}`,
        body: {},
      });
      hits.push(replay);
      expect(replay.status).toBe(201);
      const again = await call(room.baseUrl, "POST", `/j/${replayId}/accept`, {
        cookie: `commona_invite=${replaySecret}`,
        body: {},
      });
      hits.push(again);

      const revokeCreate = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: {},
      });
      hits.push(revokeCreate);
      const revokeId = (json(revokeCreate) as { invite: { id: string } }).invite.id;
      const revokeGet = await call(room.baseUrl, "GET", `/j/${revokeId}`);
      hits.push(revokeGet);
      const revokeSecret = inviteSecret(revokeGet);
      secrets.push(revokeSecret);
      const stranger = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}/invites/${revokeId}`, {
        token: room.ownerTwo,
      });
      hits.push(stranger);
      const revoked = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}/invites/${revokeId}`, {
        token: room.owner,
      });
      hits.push(revoked);
      expect(revoked.status).toBe(200);
      const afterRevoke = await call(room.baseUrl, "POST", `/j/${revokeId}/accept`, {
        cookie: `commona_invite=${revokeSecret}`,
        body: {},
      });
      hits.push(afterRevoke);

      const otherRoom = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, body: {} });
      hits.push(otherRoom);
      const roomB = (json(otherRoom) as { room: { id: string } }).room.id;
      const crossCreate = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: {},
      });
      hits.push(crossCreate);
      const crossId = (json(crossCreate) as { invite: { id: string } }).invite.id;
      const crossGet = await call(room.baseUrl, "GET", `/j/${crossId}`);
      hits.push(crossGet);
      const crossSecret = inviteSecret(crossGet);
      secrets.push(crossSecret);
      const wrongRoom = await call(room.baseUrl, "POST", `/j/${crossId}/accept`, {
        cookie: `commona_invite=${crossSecret}`,
        body: { roomId: roomB },
      });
      hits.push(wrongRoom);
      const rightRoom = await call(room.baseUrl, "POST", `/j/${crossId}/accept`, {
        cookie: `commona_invite=${crossSecret}`,
        body: { roomId: room.roomId },
      });
      hits.push(rightRoom);
      expect(rightRoom.status).toBe(201);

      const malformed = [
        await call(room.baseUrl, "POST", "/j/nope/accept", { body: {} }),
        await call(room.baseUrl, "POST", "/j/inv_not-a-uuid/accept", { body: {} }),
        await call(room.baseUrl, "POST", `/j/${encodeURIComponent("inv_' OR 1=1")}/accept`, { body: {} }),
        await call(room.baseUrl, "POST", "/j/inv_00000000-0000-4000-8000-000000000000/accept", {
          cookie: `commona_invite=${crossSecret}`,
          body: {},
        }),
      ];
      hits.push(...malformed);

      const nonMember = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.outsider,
        body: { expiresInSeconds: "soon" },
      });
      hits.push(nonMember);
      const planted = "planted-token-value-not-real-zzzz";
      const missing = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, { token: planted, body: {} });
      hits.push(missing);
      expect(missing.status).toBe(401);
      expect(json(missing)).toEqual({ error: { code: "unauthorized", message: "Missing or invalid token." } });

      const refusals = [expired, again, stranger, afterRevoke, wrongRoom, ...malformed, nonMember];
      for (const hit of refusals) {
        expect(hit.status).toBe(403);
        expect(json(hit)).toEqual(GENERIC);
        for (const name of FIXTURE_NAMES) expect(hit.bodyText).not.toContain(name);
        expect(hit.bodyText).not.toContain(room.roomId);
        expect(hit.bodyText).not.toContain(roomB);
      }
      const ownersAfter = (room.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n;
      expect(ownersAfter - ownersBefore).toBe(2);

      const flowAgents = room.issued.slice(mark).filter((item) => item.kind === "agent").map((item) => item.token);
      const auditRows = room.db
        .prepare("SELECT action, result, detail_json, room FROM audit_log")
        .all() as { action: string; result: string; detail_json: string; room: string }[];
      const refusalsLogged = auditRows.filter((row) => row.action === "join_refused" && row.result === "refused");
      expect(refusalsLogged.length).toBe(refusals.length);
      const nonMemberRow = refusalsLogged.find((row) => row.detail_json.includes("not_member"));
      expect(nonMemberRow).toBeTruthy();
      for (const name of FIXTURE_NAMES) expect(nonMemberRow?.detail_json ?? "").not.toContain(name);
      expect(auditRows.some((row) => row.action === "setting_change" && row.detail_json.includes(revokeId))).toBe(
        true,
      );

      const auditJson = JSON.stringify(auditRows);
      assertAbsent(publicBlobs(hits, room.logs, auditJson), [...secrets, ...flowAgents, planted]);
      const dump = dumpDatabase(room.db);
      for (const secret of [...secrets, ...flowAgents, planted]) expect(dump).not.toContain(secret);
      for (const secret of secrets) expect(dump).toContain(hashToken(secret));
      expect(room.audit.verify().ok).toBe(true);
    } finally {
      await room.stop();
    }
  });

  it("lets exactly one of two concurrent redeems win", async () => {
    const clock = manualClock();
    const room = await openHarness(clock);
    try {
      const created = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
        token: room.owner,
        body: {},
      });
      const id = (json(created) as { invite: { id: string } }).invite.id;
      const got = await call(room.baseUrl, "GET", `/j/${id}`);
      const secret = inviteSecret(got);
      const ownersBefore = (room.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n;
      const [first, second] = await Promise.all([
        call(room.baseUrl, "POST", `/j/${id}/accept`, { cookie: `commona_invite=${secret}`, body: {} }),
        call(room.baseUrl, "POST", `/j/${id}/accept`, { cookie: `commona_invite=${secret}`, body: {} }),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 403]);
      const bodies = [json(first), json(second)];
      expect(bodies.filter((body) => JSON.stringify(body) === JSON.stringify(GENERIC))).toHaveLength(1);
      const ownersAfter = (room.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n;
      expect(ownersAfter - ownersBefore).toBe(1);
      const winner = first.status === 201 ? first : second;
      expect(winner.bodyText).not.toContain(secret);
      expect(winner.bodyText).not.toContain(hashToken(secret));
      const loser = first.status === 403 ? first : second;
      expect(json(loser)).toEqual(GENERIC);
      expect(loser.bodyText).not.toContain(secret);
    } finally {
      await room.stop();
    }
  });
});
