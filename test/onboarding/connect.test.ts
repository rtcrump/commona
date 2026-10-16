import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken } from "../../contract/index.js";
import { startMcpHttp } from "../../connectors/mcp-server/http.js";
import { HANDOFF_TTL_MS } from "../../src/onboarding/handoff.js";
import { CONNECT_OWNER_ACTIONS } from "../../src/onboarding/connect-steps.js";
import { setInviteLog } from "../../src/join/log.js";
import { afterEach, describe, expect, it } from "vitest";
import { assertAccessible, assertNoJargon } from "./a11y.js";
import { call, CANARIES, cookieValue, seedCanaries, startJoinHarness, type JoinHarness } from "./harness.js";

const FORBIDDEN_PATH = /\/posts|\/files|\/feed|\/held/;

interface Person {
  id: string;
  session: string;
  joined: string;
}

function jar(person: Person, form?: string): string {
  const parts = [`commona_session=${person.session}`, `commona_joined=${person.joined}`];
  if (form) parts.push(`commona_form=${form}`);
  return parts.join("; ");
}

function nonceOf(html: string): string {
  return /name="nonce" value="([^"]*)"/.exec(html)?.[1] ?? "";
}

function statusText(html: string): string {
  const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
  const withoutMark = main.replace(/<p class="mark">[\s\S]*?<\/p>/, "");
  return withoutMark.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tableCount(db: JoinHarness["db"], table: "posts" | "files"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function dumpDatabase(db: JoinHarness["db"]): string {
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

function assertAbsent(blobs: string[], secrets: string[]): void {
  const haystack = blobs.join("\n");
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(20);
    expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(hashToken(secret));
  }
}

function recordFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(`${init?.method ?? "GET"} ${new URL(raw).pathname}`);
    return fetch(input, init);
  };
}

async function initializeMcp(url: string): Promise<{ status: number; body: string; sessionId: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "commona-test", version: "0" },
      },
    }),
  });
  return {
    status: response.status,
    body: await response.text(),
    sessionId: response.headers.get("mcp-session-id") ?? "",
  };
}

async function deleteMcp(url: string, sessionId: string): Promise<number> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, accept: "application/json" },
  });
  return response.status;
}

async function joinPerson(room: JoinHarness, roomId: string, name: string): Promise<Person> {
  const created = await call(room.baseUrl, "POST", `/rooms/${roomId}/invites`, { token: room.owner, json: {} });
  if (created.status !== 201) throw new Error(created.body);
  const id = (JSON.parse(created.body) as { invite: { id: string } }).invite.id;
  const welcome = await call(room.baseUrl, "GET", `/j/${id}`, { accept: "text/html" });
  const invite = cookieValue(welcome.setCookies, "commona_invite");
  const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
  await call(room.baseUrl, "POST", `/j/${id}/continue`, {
    cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
    form: { nonce: welcomeNonce, firstName: name },
  });
  const sharing = await call(room.baseUrl, "GET", `/j/${id}/sharing`, {
    accept: "text/html",
    cookie: `commona_invite=${invite}`,
  });
  const shareNonce = cookieValue(sharing.setCookies, "commona_form");
  const finished = await call(room.baseUrl, "POST", `/j/${id}/finish`, {
    cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
    form: { nonce: shareNonce, seeing: "Nothing" },
  });
  return {
    id,
    session: cookieValue(finished.setCookies, "commona_session"),
    joined: cookieValue(finished.setCookies, "commona_joined"),
  };
}

async function openGuided(room: JoinHarness, person: Person) {
  const page = await call(room.baseUrl, "GET", `/j/${person.id}/connect`, {
    accept: "text/html",
    cookie: jar(person),
  });
  return { page, form: cookieValue(page.setCookies, "commona_form"), nonce: nonceOf(page.body) };
}

function agentHash(room: JoinHarness, name: string): string {
  const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get(name) as { id: string };
  const agent = room.db.prepare("SELECT agent_id FROM owner_agents WHERE owner_id = ?").get(owner.id) as {
    agent_id: string;
  };
  const row = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agent.agent_id) as {
    token_hash: string;
  };
  return row.token_hash;
}

function ownerRecord(room: JoinHarness, name: string): { id: string; agentId: string } {
  const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get(name) as { id: string };
  const agent = room.db.prepare("SELECT agent_id FROM owner_agents WHERE owner_id = ?").get(owner.id) as {
    agent_id: string;
  };
  return { id: owner.id, agentId: agent.agent_id };
}

describe("guided connect", () => {
  let room: JoinHarness | undefined;
  let connector: { url: string; close(): Promise<void> } | undefined;
  let stateDir: string | undefined;
  const previousConnect = process.env.COMMONA_CONNECT_URL;

  afterEach(async () => {
    await connector?.close();
    connector = undefined;
    await room?.stop();
    room = undefined;
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
    setInviteLog(() => {});
    if (previousConnect === undefined) delete process.env.COMMONA_CONNECT_URL;
    else process.env.COMMONA_CONNECT_URL = previousConnect;
  });

  it("connects from one pasted link and never posts or shows the room", async () => {
    room = await startJoinHarness();
    seedCanaries(room.db, room.roomId);
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const postsBefore = tableCount(room.db, "posts");
    const filesBefore = tableCount(room.db, "files");
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    const calls: string[] = [];
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      fetchImpl: recordFetch(calls),
    });
    process.env.COMMONA_CONNECT_URL = connector.url;

    const person = await joinPerson(room, room.roomId, "Alex");
    const first = await openGuided(room, person);
    expect(first.page.status).toBe(200);
    expect(CONNECT_OWNER_ACTIONS.length).toBeLessThanOrEqual(3);
    const steps = [...first.page.body.matchAll(/<li>([\s\S]*?)<\/li>/g)];
    expect(steps.length).toBe(CONNECT_OWNER_ACTIONS.length);
    expect(steps.length).toBeLessThanOrEqual(3);
    for (const step of CONNECT_OWNER_ACTIONS) expect(first.page.body).toContain(step.text);
    expect(first.page.body).toContain("Check connection");
    expect(first.page.body).toContain("Don't use Claude? Tell Owner One.");
    expect(first.page.body).toContain("(unverified)");
    expect(first.page.body).not.toContain(room.roomId);
    expect(first.page.body).not.toContain("Sunday lunch");
    expect(first.page.body).not.toContain("handoff=");
    assertAccessible(first.page.body);
    assertNoJargon(first.page.body);
    for (const canary of CANARIES) expect(first.page.body).not.toContain(canary);

    const script = await call(room.baseUrl, "GET", "/onboarding/connect.js");
    expect(script.status).toBe(200);
    expect(script.body).not.toMatch(/\/rooms\//);
    expect(script.body).not.toMatch(/\bposts\b/);
    for (const word of ["token", "webhook", "mcp", "api", "credential"]) {
      expect(script.body.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b`));
    }

    const offline = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, first.form),
      form: { nonce: first.nonce },
    });
    expect(offline.status).toBe(200);
    expect(statusText(offline.body)).toBe("Not connected");
    expect(offline.body).not.toContain(room.roomId);
    expect(offline.body).not.toContain("Sunday lunch");
    for (const canary of CANARIES) expect(offline.body).not.toContain(canary);
    assertNoJargon(offline.body);
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);

    const ownerActions = [
      CONNECT_OWNER_ACTIONS[0]?.text ?? "",
      CONNECT_OWNER_ACTIONS[1]?.text ?? "",
      CONNECT_OWNER_ACTIONS[2]?.text ?? "",
    ];
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, first.form),
      json: { nonce: first.nonce },
    });
    expect(copied.status).toBe(200);
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    expect(link.searchParams.get("room")).toBe(room.roomId);
    expect(secret.length).toBeGreaterThan(20);
    expect(ownerActions).toHaveLength(3);
    expect(ownerActions.length).toBeLessThanOrEqual(3);

    const afterCopy = await openGuided(room, person);
    expect(afterCopy.page.body).not.toContain(secret);
    expect(afterCopy.page.body).not.toContain(hashToken(secret));
    for (const label of afterCopy.page.body.matchAll(/aria-label="([^"]*)"/g)) {
      expect(label[1]).not.toContain(secret);
    }
    expect(afterCopy.page.body).toContain('aria-label="Copy my link"');

    const wrongRoom = new URL(link.toString());
    wrongRoom.searchParams.set("room", "room_other");
    const issuedBefore = room.issued.length;
    const refused = await initializeMcp(wrongRoom.toString());
    expect(refused.status).toBe(200);
    expect(refused.body).toContain("The connector link is dead.");
    expect(refused.body).not.toContain(secret);
    expect(room.issued.length).toBe(issuedBefore);

    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    expect(opened.body).not.toContain(secret);
    const credential = room.issued.slice(issuedBefore).find((item) => item.kind === "agent")?.token ?? "";
    expect(credential.length).toBeGreaterThan(20);
    expect(opened.body).not.toContain(credential);
    expect(room.tokens.authenticate(credential)).toMatchObject({
      kind: "agent",
      ownerId: ownerRecord(room, "Alex").id,
    });

    const connectedPage = await openGuided(room, person);
    expect(connectedPage.page.body).toContain("Your assistant is connected");
    expect(connectedPage.page.body).toContain("Get a new link");
    expect(connectedPage.page.body).not.toContain(secret);
    expect(connectedPage.page.body).not.toContain(credential);
    for (const label of connectedPage.page.body.matchAll(/aria-label="([^"]*)"/g)) {
      expect(label[1]).not.toContain(secret);
      expect(label[1]).not.toContain(credential);
    }

    const online = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, connectedPage.form),
      form: { nonce: connectedPage.nonce },
    });
    expect(online.status).toBe(200);
    expect(statusText(online.body)).toBe("Connected");
    expect(online.body).not.toContain(room.roomId);
    expect(online.body).not.toContain("Sunday lunch");
    expect(online.body).not.toContain(secret);
    expect(online.body).not.toContain(credential);
    for (const canary of CANARIES) expect(online.body).not.toContain(canary);
    assertNoJargon(online.body);
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);
    expect(calls.some((line) => FORBIDDEN_PATH.test(line))).toBe(false);

    const issuedAfterOpen = room.issued.length;
    const again = await initializeMcp(link.toString());
    expect(again.status).toBe(200);
    expect(again.body).toContain("2025-06-18");
    expect(again.body).not.toContain("The connector link is dead.");
    expect(again.body).not.toContain(secret);
    expect(again.body).not.toContain(credential);
    expect(room.issued.length).toBe(issuedAfterOpen);
    expect(room.tokens.authenticate(credential)).toMatchObject({
      kind: "agent",
      ownerId: ownerRecord(room, "Alex").id,
    });

    await connector.close();
    connector = undefined;
    const gone = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, connectedPage.form),
      form: { nonce: connectedPage.nonce },
    });
    expect(statusText(gone.body)).toBe("Not connected");
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);

    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent(
      [
        first.page.body,
        afterCopy.page.body,
        connectedPage.page.body,
        offline.body,
        online.body,
        gone.body,
        script.body,
        refused.body,
        opened.body,
        again.body,
        ...logs,
        audit,
      ],
      [secret, credential, person.session],
    );
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(credential);
    expect(dump).toContain(hashToken(secret));
  });

  it("refuses another room and another owner", async () => {
    room = await startJoinHarness();
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    connector = await startMcpHttp({ config: { baseUrl: room.baseUrl, wakePollMs: 20 } });
    process.env.COMMONA_CONNECT_URL = connector.url;
    const made = await call(room.baseUrl, "POST", "/rooms", { token: room.owner, json: {} });
    const room2 = (JSON.parse(made.body) as { room: { id: string } }).room.id;
    await call(room.baseUrl, "POST", `/rooms/${room2}/members`, { token: room.owner, json: { agentId: "A1" } });

    const alex = await joinPerson(room, room.roomId, "Alex");
    const blair = await joinPerson(room, room2, "Blair");
    const alexPage = await openGuided(room, alex);
    const blairPage = await openGuided(room, blair);
    const alexCopy = await call(room.baseUrl, "POST", `/j/${alex.id}/connect/link`, {
      cookie: jar(alex, alexPage.form),
      json: { nonce: alexPage.nonce },
    });
    const blairCopy = await call(room.baseUrl, "POST", `/j/${blair.id}/connect/link`, {
      cookie: jar(blair, blairPage.form),
      json: { nonce: blairPage.nonce },
    });
    const alexLink = new URL((JSON.parse(alexCopy.body) as { url: string }).url);
    const blairLink = new URL((JSON.parse(blairCopy.body) as { url: string }).url);
    const alexSecret = alexLink.searchParams.get("handoff") ?? "";
    const blairSecret = blairLink.searchParams.get("handoff") ?? "";
    const alexHash = agentHash(room, "Alex");
    const blairHash = agentHash(room, "Blair");

    const wrongRoom = new URL(alexLink.toString());
    wrongRoom.searchParams.set("room", room2);
    const refused = await initializeMcp(wrongRoom.toString());
    expect(refused.body).toContain("The connector link is dead.");
    expect(agentHash(room, "Alex")).toBe(alexHash);

    const cross = await call(room.baseUrl, "POST", "/connect/claim", {
      json: { handoff: blairSecret, roomId: room.roomId, ownerId: ownerRecord(room, "Alex").id },
    });
    expect(cross.status).toBe(403);
    expect(cross.body).not.toContain(blairSecret);
    expect(agentHash(room, "Blair")).toBe(blairHash);

    const claimed = await call(room.baseUrl, "POST", "/connect/claim", {
      json: { handoff: alexSecret, roomId: room.roomId, ownerId: "O1" },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body).not.toContain(alexSecret);
    const credential = (JSON.parse(claimed.body) as { credential: string; ownerId: string }).credential;
    const alexOwner = ownerRecord(room, "Alex");
    expect(JSON.parse(claimed.body).ownerId).toBe(alexOwner.id);
    expect(room.tokens.authenticate(credential)).toEqual({
      kind: "agent",
      ownerId: alexOwner.id,
      agentId: alexOwner.agentId,
    });
    const arrived = await call(room.baseUrl, "POST", "/connect/arrive", { token: credential });
    expect(arrived.status).toBe(200);
    const auditDb = room.db;
    const arrivalRows = () =>
      (
        auditDb
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setting_change' AND instr(detail_json, 'authorAgentId') > 0",
          )
          .get() as { n: number }
      ).n;
    expect(arrivalRows()).toBe(1);
    const again = await call(room.baseUrl, "POST", "/connect/arrive", { token: credential });
    expect(again.status).toBe(200);
    expect(arrivalRows()).toBe(1);
    const alexAfter = await openGuided(room, alex);
    const blairAfter = await openGuided(room, blair);
    expect(alexAfter.page.body).toContain("Your assistant is connected");
    expect(blairAfter.page.body).not.toContain("Your assistant is connected");
    expect(blairAfter.page.body).toContain("Connect your assistant");

    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    const second = await call(room.baseUrl, "POST", "/connect/claim", {
      json: { handoff: alexSecret, roomId: room.roomId },
    });
    expect(second.status).toBe(403);
    expect(second.body).not.toContain(alexSecret);
    expect(second.body).not.toContain(credential);
    expect(room.tokens.authenticate(credential)).toEqual({
      kind: "agent",
      ownerId: alexOwner.id,
      agentId: alexOwner.agentId,
    });

    assertAbsent(
      [alexAfter.page.body, blairAfter.page.body, refused.body, cross.body, second.body, ...logs, audit],
      [alexSecret, blairSecret, credential, alex.session, blair.session],
    );
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(alexSecret);
    expect(dump).not.toContain(blairSecret);
    expect(dump).not.toContain(credential);
  });

  it("expires the link after ten minutes", async () => {
    room = await startJoinHarness();
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    connector = await startMcpHttp({ config: { baseUrl: room.baseUrl, wakePollMs: 20 } });
    process.env.COMMONA_CONNECT_URL = connector.url;
    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    const hashBefore = agentHash(room, "Alex");
    room.clock.advance(HANDOFF_TTL_MS);
    const expiredPage = await openGuided(room, person);
    expect(expiredPage.page.body).toContain("Get a new link");
    expect(expiredPage.page.body).toContain("ran out of time");
    expect(expiredPage.page.body).not.toContain(secret);
    const refused = await initializeMcp(link.toString());
    expect(refused.body).toContain("The connector link is dead.");
    expect(refused.body).not.toContain(secret);
    expect(agentHash(room, "Alex")).toBe(hashBefore);
    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent([expiredPage.page.body, refused.body, ...logs, audit], [secret, person.session]);
  });

  it("keeps the same link when Claude connects again", async () => {
    room = await startJoinHarness();
    seedCanaries(room.db, room.roomId);
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const postsBefore = tableCount(room.db, "posts");
    const filesBefore = tableCount(room.db, "files");
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    const calls: string[] = [];
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      fetchImpl: recordFetch(calls),
    });
    process.env.COMMONA_CONNECT_URL = connector.url;

    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    const issuedBefore = room.issued.length;

    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    expect(opened.body).not.toContain(secret);
    const credential = room.issued.slice(issuedBefore).find((item) => item.kind === "agent")?.token ?? "";
    expect(credential.length).toBeGreaterThan(20);
    expect(opened.body).not.toContain(credential);
    const boundHash = agentHash(room, "Alex");

    const connected = await openGuided(room, person);
    expect(connected.page.body).toContain("Your assistant is connected");
    expect(connected.page.body).toContain("Claude can keep using that link");
    expect(connected.page.body).not.toContain("ran out of time");
    expect(connected.page.body).not.toContain(secret);
    expect(connected.page.body).not.toContain(room.roomId);
    expect(connected.page.body).not.toContain("Sunday lunch");
    for (const canary of CANARIES) expect(connected.page.body).not.toContain(canary);

    const wrongRoom = new URL(link.toString());
    wrongRoom.searchParams.set("room", "room_other");
    const refused = await initializeMcp(wrongRoom.toString());
    expect(refused.body).toContain("The connector link is dead.");
    expect(refused.body).not.toContain(secret);
    expect(agentHash(room, "Alex")).toBe(boundHash);

    room.clock.advance(HANDOFF_TTL_MS);
    const stillBound = await openGuided(room, person);
    expect(stillBound.page.body).toContain("Claude can keep using that link");
    expect(stillBound.page.body).not.toContain("ran out of time");
    expect(stillBound.page.body).not.toContain(secret);

    const issuedAfterOpen = room.issued.length;
    const again = await initializeMcp(link.toString());
    expect(again.status).toBe(200);
    expect(again.body).toContain("2025-06-18");
    expect(again.body).not.toContain("The connector link is dead.");
    expect(again.body).not.toContain(secret);
    expect(again.body).not.toContain(credential);
    expect(room.issued.length).toBe(issuedAfterOpen);
    expect(room.tokens.authenticate(credential)).toMatchObject({ kind: "agent", ownerId: ownerRecord(room, "Alex").id });
    await expect(deleteMcp(link.toString(), opened.sessionId)).resolves.toBe(204);

    const reopened = await initializeMcp(link.toString());
    expect(reopened.status).toBe(200);
    expect(reopened.body).toContain("2025-06-18");
    expect(reopened.body).not.toContain(secret);
    expect(reopened.body).not.toContain(credential);
    expect(room.issued.length).toBe(issuedAfterOpen);
    expect(agentHash(room, "Alex")).toBe(boundHash);

    const online = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, stillBound.form),
      form: { nonce: stillBound.nonce },
    });
    expect(online.status).toBe(200);
    expect(statusText(online.body)).toBe("Connected");
    expect(online.body).not.toContain(room.roomId);
    expect(online.body).not.toContain("Sunday lunch");
    expect(online.body).not.toContain(secret);
    expect(online.body).not.toContain(credential);
    for (const canary of CANARIES) expect(online.body).not.toContain(canary);
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);
    expect(calls.some((line) => FORBIDDEN_PATH.test(line))).toBe(false);

    const other = await startMcpHttp({ config: { baseUrl: room.baseUrl, wakePollMs: 20 } });
    const replay = new URL(other.url);
    replay.search = link.search;
    const retired = await initializeMcp(replay.toString());
    await other.close();
    expect(retired.body).toContain("The connector link is dead.");
    expect(retired.body).not.toContain(secret);
    expect(retired.body).not.toContain(credential);
    expect(agentHash(room, "Alex")).toBe(boundHash);
    expect(room.tokens.authenticate(credential)).toMatchObject({ kind: "agent" });
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);

    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent(
      [
        page.page.body,
        connected.page.body,
        stillBound.page.body,
        online.body,
        opened.body,
        refused.body,
        again.body,
        reopened.body,
        retired.body,
        ...logs,
        audit,
      ],
      [secret, credential, person.session],
    );
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(credential);
    expect(dump).toContain(hashToken(secret));
  });

  it("resumes connect from the owner session", async () => {
    room = await startJoinHarness();
    seedCanaries(room.db, room.roomId);
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const person = await joinPerson(room, room.roomId, "Alex");
    const resumed = await call(room.baseUrl, "GET", `/j/${person.id}/connect`, {
      accept: "text/html",
      cookie: `commona_session=${person.session}`,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toContain("Check connection");
    expect(resumed.body).not.toContain(room.roomId);
    expect(resumed.body).not.toContain("Sunday lunch");
    for (const canary of CANARIES) expect(resumed.body).not.toContain(canary);
    assertNoJargon(resumed.body);

    const restarted = await call(room.baseUrl, "GET", `/j/${person.id}/connect`, {
      accept: "text/html",
      cookie: `commona_session=${person.session}; commona_joined=missing-marker`,
    });
    expect(restarted.status).toBe(200);
    expect(restarted.body).toContain("Check connection");
    expect(restarted.body).not.toContain("Sunday lunch");

    const outsider = await call(room.baseUrl, "GET", `/j/${person.id}/connect`, {
      accept: "text/html",
      cookie: `commona_session=${room.owner}`,
    });
    expect(outsider.body).not.toContain("Check connection");
    expect(outsider.body).not.toContain("Sunday lunch");
    const anon = await call(room.baseUrl, "GET", `/j/${person.id}/connect`, { accept: "text/html" });
    expect(anon.body).not.toContain("Check connection");
  });

  it("answers Check connection when wake polling is slow", async () => {
    room = await startJoinHarness();
    const postsBefore = tableCount(room.db, "posts");
    const filesBefore = tableCount(room.db, "files");
    connector = await startMcpHttp({ config: { baseUrl: room.baseUrl, wakePollMs: 60_000 } });
    process.env.COMMONA_CONNECT_URL = connector.url;
    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const opened = await initializeMcp(link.toString());
    expect(opened.body).toContain("2025-06-18");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const checked = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, page.form),
      form: { nonce: page.nonce },
    });
    expect(checked.status).toBe(200);
    expect(statusText(checked.body)).toBe("Connected");
    expect(checked.body).not.toContain(room.roomId);
    expect(tableCount(room.db, "posts")).toBe(postsBefore);
    expect(tableCount(room.db, "files")).toBe(filesBefore);
  });

  it("requires the bearer when the handoff query is not a real link", async () => {
    room = await startJoinHarness();
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      bearer: "test-bearer",
    });
    const bogus = new URL(connector.url);
    bogus.searchParams.set("handoff", "not-a-real-handoff");
    bogus.searchParams.set("room", room.roomId);
    const denied = await initializeMcp(bogus.toString());
    expect(denied.status).toBe(401);
    expect(denied.body).not.toContain("not-a-real-handoff");

    const authed = await fetch(connector.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-bearer",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(authed.status).toBe(200);
    const session = authed.headers.get("mcp-session-id") ?? "";
    const hijack = new URL(connector.url);
    hijack.searchParams.set("handoff", "not-a-real-handoff");
    hijack.searchParams.set("room", room.roomId);
    const stolen = await fetch(hijack, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-session-id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(stolen.status).toBe(401);

    process.env.COMMONA_CONNECT_URL = connector.url;
    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    const secret = link.searchParams.get("handoff") ?? "";
    expect(opened.body).not.toContain(secret);
  });

  it("keeps the claimed credential when arrival reporting fails", async () => {
    room = await startJoinHarness();
    let arriveAttempts = 0;
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      fetchImpl: async (input, init) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(raw).pathname === "/connect/arrive") {
          arriveAttempts += 1;
          if (arriveAttempts === 1) return new Response("unavailable", { status: 503 });
        }
        return fetch(input, init);
      },
    });
    process.env.COMMONA_CONNECT_URL = connector.url;
    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const issuedBefore = room.issued.length;
    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    expect(opened.body).not.toContain("The connector link is dead.");
    const credential = room.issued.slice(issuedBefore).find((item) => item.kind === "agent")?.token ?? "";
    expect(room.tokens.authenticate(credential)).toMatchObject({ kind: "agent" });
    expect(arriveAttempts).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(arriveAttempts).toBeGreaterThanOrEqual(2);
    const connected = await openGuided(room, person);
    expect(connected.page.body).toContain("Your assistant is connected");
    const again = await initializeMcp(link.toString());
    expect(again.status).toBe(200);
    expect(again.body).not.toContain("The connector link is dead.");
    expect(room.issued.length).toBe(issuedBefore + 1);
    expect(room.tokens.authenticate(credential)).toMatchObject({ kind: "agent" });
  });

  it("reconnects a bound link after the connector restarts", async () => {
    room = await startJoinHarness();
    stateDir = mkdtempSync(join(tmpdir(), "commona-mcp-"));
    const statePath = join(stateDir, "links.json");
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    process.env.COMMONA_CONNECT_URL = connector.url;

    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    const issuedBefore = room.issued.length;
    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    expect(opened.body).not.toContain("The connector link is dead.");
    const credential = room.issued.slice(issuedBefore).find((item) => item.kind === "agent")?.token ?? "";
    expect(credential.length).toBeGreaterThan(20);
    const boundHash = agentHash(room, "Alex");
    const saved = readFileSync(statePath, "utf8");
    expect(saved).toContain(hashToken(secret));
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(credential);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    await connector.close();
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    const replay = new URL(connector.url);
    replay.search = link.search;
    const again = await initializeMcp(replay.toString());
    expect(again.status).toBe(200);
    expect(again.body).toContain("2025-06-18");
    expect(again.body).not.toContain("The connector link is dead.");
    expect(again.body).not.toContain(secret);
    expect(again.body).not.toContain(credential);
    expect(room.issued.length).toBe(issuedBefore + 1);
    expect(agentHash(room, "Alex")).toBe(boundHash);
    expect(room.tokens.authenticate(credential)).toMatchObject({
      kind: "agent",
      ownerId: ownerRecord(room, "Alex").id,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const connected = await openGuided(room, person);
    const online = await call(room.baseUrl, "POST", `/j/${person.id}/connect/check`, {
      cookie: jar(person, connected.form),
      form: { nonce: connected.nonce },
    });
    expect(online.status).toBe(200);
    expect(statusText(online.body)).toBe("Connected");
    expect(online.body).not.toContain(secret);
    expect(online.body).not.toContain(credential);

    const kept = readFileSync(statePath, "utf8");
    expect(kept).toContain(hashToken(secret));
    expect(kept).not.toContain(secret);
    expect(kept).not.toContain(credential);
    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent(
      [page.page.body, connected.page.body, online.body, opened.body, again.body, ...logs, audit],
      [secret, credential, person.session],
    );
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(credential);
    expect(dump).toContain(hashToken(secret));
  });

  it("expires an unused handoff ten minutes after a restart", async () => {
    room = await startJoinHarness();
    stateDir = mkdtempSync(join(tmpdir(), "commona-mcp-"));
    const statePath = join(stateDir, "links.json");
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    process.env.COMMONA_CONNECT_URL = connector.url;

    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    const hashBefore = agentHash(room, "Alex");
    const issuedBefore = room.issued.length;

    await connector.close();
    connector = undefined;
    room.clock.advance(HANDOFF_TTL_MS);
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    const replay = new URL(connector.url);
    replay.search = link.search;
    const refused = await initializeMcp(replay.toString());
    expect(refused.status).toBe(200);
    expect(refused.body).toContain("The connector link is dead.");
    expect(refused.body).not.toContain(secret);
    expect(room.issued.length).toBe(issuedBefore);
    expect(agentHash(room, "Alex")).toBe(hashBefore);

    const expiredPage = await openGuided(room, person);
    expect(expiredPage.page.body).toContain("Get a new link");
    expect(expiredPage.page.body).toContain("ran out of time");
    expect(expiredPage.page.body).not.toContain(secret);
    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent([page.page.body, expiredPage.page.body, refused.body, ...logs, audit], [secret, person.session]);
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(secret);
    expect(dump).toContain(hashToken(secret));
  });

  it("keeps a replaced link dead after a restart", async () => {
    room = await startJoinHarness();
    stateDir = mkdtempSync(join(tmpdir(), "commona-mcp-"));
    const statePath = join(stateDir, "links.json");
    const logs: string[] = [];
    setInviteLog((line) => logs.push(line));
    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    process.env.COMMONA_CONNECT_URL = connector.url;

    const person = await joinPerson(room, room.roomId, "Alex");
    const page = await openGuided(room, person);
    const copied = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, page.form),
      json: { nonce: page.nonce },
    });
    const link = new URL((JSON.parse(copied.body) as { url: string }).url);
    const secret = link.searchParams.get("handoff") ?? "";
    const issuedBefore = room.issued.length;
    const opened = await initializeMcp(link.toString());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("2025-06-18");
    const credential = room.issued.slice(issuedBefore).find((item) => item.kind === "agent")?.token ?? "";
    const boundHash = agentHash(room, "Alex");
    const issuedAfter = room.issued.length;

    await connector.close();
    connector = undefined;
    const replacedPage = await openGuided(room, person);
    const copiedAgain = await call(room.baseUrl, "POST", `/j/${person.id}/connect/link`, {
      cookie: jar(person, replacedPage.form),
      json: { nonce: replacedPage.nonce },
    });
    const replacement = new URL((JSON.parse(copiedAgain.body) as { url: string }).url);
    const newSecret = replacement.searchParams.get("handoff") ?? "";
    expect(newSecret).not.toBe(secret);

    connector = await startMcpHttp({
      config: { baseUrl: room.baseUrl, wakePollMs: 20 },
      statePath,
    });
    const replay = new URL(connector.url);
    replay.search = link.search;
    const retired = await initializeMcp(replay.toString());
    expect(retired.status).toBe(200);
    expect(retired.body).toContain("The connector link is dead.");
    expect(retired.body).not.toContain(secret);
    expect(retired.body).not.toContain(newSecret);
    expect(retired.body).not.toContain(credential);
    expect(room.issued.length).toBe(issuedAfter);
    expect(agentHash(room, "Alex")).toBe(boundHash);
    expect(room.tokens.authenticate(credential)).toMatchObject({ kind: "agent" });

    const saved = readFileSync(statePath, "utf8");
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(newSecret);
    expect(saved).not.toContain(credential);
    expect(saved).not.toContain(hashToken(secret));
    const audit = JSON.stringify(room.db.prepare("SELECT action, detail_json FROM audit_log").all());
    assertAbsent(
      [page.page.body, replacedPage.page.body, opened.body, retired.body, ...logs, audit],
      [secret, newSecret, credential, person.session],
    );
    const dump = dumpDatabase(room.db);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(newSecret);
    expect(dump).not.toContain(credential);
    expect(dump).toContain(hashToken(secret));
    expect(dump).toContain(hashToken(newSecret));
  });
});

describe("connect copy button", () => {
  it("ignores a second click while the first copy is still going", async () => {
    const source = readFileSync(new URL("../../web/onboarding/connect.js", import.meta.url), "utf8");
    class ButtonElement {
      disabled = false;
      listeners: Array<() => void> = [];
      getAttribute(name: string): string | null {
        return name === "data-copy" ? "/j/invite_test/connect/link" : null;
      }
      addEventListener(_type: string, fn: () => void): void {
        this.listeners.push(fn);
      }
    }
    class InputElement {
      value = "nonce-1";
    }
    const button = new ButtonElement();
    const input = new InputElement();
    let fetches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = new Function(
      "document",
      "fetch",
      "navigator",
      "HTMLButtonElement",
      "HTMLInputElement",
      source,
    ) as (document: unknown, fetch: unknown, navigator: unknown, buttonType: unknown, inputType: unknown) => void;
    run(
      {
        querySelector(selector: string) {
          if (selector === "#copy-link") return button;
          if (selector === 'input[name="nonce"]') return input;
          return null;
        },
      },
      async () => {
        fetches += 1;
        await gate;
        return { ok: true, json: async () => ({ url: "http://127.0.0.1/mcp?handoff=kept" }) };
      },
      { clipboard: { writeText: async () => undefined } },
      ButtonElement,
      InputElement,
    );
    button.listeners[0]?.();
    button.listeners[0]?.();
    expect(fetches).toBe(1);
    expect(button.disabled).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.disabled).toBe(false);
    expect(fetches).toBe(1);
  });
});
