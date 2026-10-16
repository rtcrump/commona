import { hashToken, SharingLevel } from "../../contract/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { assertAccessible, assertNoJargon, assertStyles, stripNonce } from "./a11y.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "./harness.js";

function freeze(html: string, inviteId: string): string {
  return stripNonce(html).replaceAll(inviteId, "INVITE");
}

function locationPath(location: string | null): string {
  expect(location).toBeTruthy();
  const value = location ?? "";
  expect(value).not.toContain("?");
  expect(value).not.toContain("#");
  return value.startsWith("http") ? new URL(value).pathname : value;
}

async function openWelcome(room: JoinHarness, id: string) {
  return call(room.baseUrl, "GET", `/j/${id}`, { accept: "text/html" });
}

describe("join pages", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("snapshots the welcome, sharing, and done pages and stores None by default", async () => {
    room = await startJoinHarness();
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const id = await createInvite(room);
    const mark = room.issued.length;
    const welcome = await openWelcome(room, id);
    expect(welcome.status).toBe(200);
    expect(welcome.contentType).toContain("text/html");
    expect(welcome.body).toContain("Owner One invited you to Sunday lunch.");
    expect(welcome.body).not.toContain(room.roomId);
    assertAccessible(welcome.body);
    assertNoJargon(welcome.body);
    expect(freeze(welcome.body, id)).toMatchSnapshot("welcome");

    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    expect(invite.length).toBeGreaterThan(20);
    expect(welcome.body).not.toContain(invite);

    const continued = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: "Alex" },
    });
    expect(continued.status).toBe(303);
    expect(locationPath(continued.location)).toBe(`/j/${id}/sharing`);

    const sharing = await call(room.baseUrl, "GET", `/j/${id}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    expect(sharing.status).toBe(200);
    expect(sharing.body).toContain("Safest");
    expect(sharing.body).toContain('value="Nothing" checked');
    expect(sharing.body).not.toContain(room.roomId);
    assertAccessible(sharing.body);
    assertNoJargon(sharing.body);
    expect(freeze(sharing.body, id)).toMatchSnapshot("sharing");

    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${id}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce, seeing: "Nothing" },
    });
    expect(finished.status).toBe(303);
    expect(locationPath(finished.location)).toBe(`/j/${id}/done`);
    const session = cookieValue(finished.setCookies, "commona_session");
    const joined = cookieValue(finished.setCookies, "commona_joined");
    expect(session.length).toBeGreaterThan(20);
    expect(finished.body).not.toContain(session);
    expect(finished.location ?? "").not.toContain(session);

    const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get("Alex") as { id: string };
    expect(room.sharing.level(room.roomId, owner.id, "O1")).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, owner.id, "O2")).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, "O1", owner.id)).toBe(SharingLevel.None);

    const done = await call(room.baseUrl, "GET", `/j/${id}/done`, {
      accept: "text/html",
      cookie: `commona_joined=${joined}`,
    });
    expect(done.status).toBe(200);
    expect(done.body).toContain("You're in.");
    expect(done.body).toContain("Next we'll connect your assistant.");
    expect(done.body).toContain('href="/join/connect"');
    expect(done.body).not.toContain(room.roomId);
    assertAccessible(done.body);
    assertNoJargon(done.body);
    expect(freeze(done.body, id)).toMatchSnapshot("done");

    const connect = await call(room.baseUrl, "GET", "/join/connect", { accept: "text/html" });
    expect(connect.status).toBe(200);
    assertAccessible(connect.body);
    assertNoJargon(connect.body);

    const css = await call(room.baseUrl, "GET", "/onboarding/join.css");
    expect(css.status).toBe(200);
    expect(css.contentType).toContain("text/css");
    assertStyles(css.body);
    assertNoJargon(css.body);

    const secrets = [
      invite,
      session,
      joined,
      ...room.issued.slice(mark).map((item) => item.token),
    ];
    const publicText = [welcome.body, sharing.body, done.body, connect.body, continued.location, finished.location]
      .filter((value): value is string => value !== null)
      .join("\n");
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(20);
      expect(publicText).not.toContain(secret);
      expect(publicText).not.toContain(hashToken(secret));
    }
  });

  it("stores None when the sharing form omits the choice", async () => {
    room = await startJoinHarness();
    const id = await createInvite(room);
    const welcome = await openWelcome(room, id);
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    const continued = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: "Alex" },
    });
    expect(continued.status).toBe(303);
    const sharing = await call(room.baseUrl, "GET", `/j/${id}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${id}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce },
    });
    expect(finished.status).toBe(303);
    const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get("Alex") as { id: string };
    expect(room.sharing.level(room.roomId, owner.id, "O1")).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, "O1", owner.id)).toBe(SharingLevel.None);
  });

  it("stores Messages when that choice is submitted", async () => {
    room = await startJoinHarness();
    const id = await createInvite(room);
    const welcome = await openWelcome(room, id);
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: "Blair" },
    });
    const sharing = await call(room.baseUrl, "GET", `/j/${id}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${id}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce, seeing: "Messages" },
    });
    expect(finished.status).toBe(303);
    const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get("Blair") as { id: string };
    expect(room.sharing.level(room.roomId, owner.id, "O1")).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, owner.id, "O2")).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O1", owner.id)).toBe(SharingLevel.None);

    const filesId = await createInvite(room);
    const filesWelcome = await openWelcome(room, filesId);
    const filesInvite = cookieValue(filesWelcome.setCookies, "commona_invite");
    const filesNonce = cookieValue(filesWelcome.setCookies, "commona_form");
    await call(room.baseUrl, "POST", `/j/${filesId}/continue`, {
      cookie: `commona_invite=${filesInvite}; commona_form=${filesNonce}`,
      form: { nonce: filesNonce, firstName: "Casey" },
    });
    const filesSharing = await call(room.baseUrl, "GET", `/j/${filesId}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${filesInvite}`,
    });
    const filesShareNonce = cookieValue(filesSharing.setCookies, "commona_form");
    const filesFinished = await call(room.baseUrl, "POST", `/j/${filesId}/finish`, {
      cookie: `commona_invite=${filesInvite}; commona_form=${filesShareNonce}`,
      form: { nonce: filesShareNonce, seeing: "Messages and files" },
    });
    expect(filesFinished.status).toBe(303);
    const filesOwner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get("Casey") as { id: string };
    expect(room.sharing.level(room.roomId, filesOwner.id, "O1")).toBe(SharingLevel.MessagesFiles);
    expect(room.sharing.level(room.roomId, "O1", filesOwner.id)).toBe(SharingLevel.None);
  });

  it("snapshots expired, used, and revoked pages without room details", async () => {
    room = await startJoinHarness();
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");

    const expiredId = await createInvite(room, 60);
    room.clock.advance(60_000);
    const expired = await openWelcome(room, expiredId);
    expect(expired.status).toBe(200);
    expect(expired.body).toContain("This link has expired, so ask Owner One for a new link.");
    expect(expired.body).not.toContain("Sunday lunch");
    expect(expired.body).not.toContain(room.roomId);
    assertAccessible(expired.body);
    assertNoJargon(expired.body);
    expect(freeze(expired.body, expiredId)).toMatchSnapshot("expired");

    const usedId = await createInvite(room);
    const usedGet = await call(room.baseUrl, "GET", `/j/${usedId}`);
    expect(usedGet.status).toBe(200);
    expect(JSON.parse(usedGet.body)).toEqual({ ok: true });
    const usedSecret = cookieValue(usedGet.setCookies, "commona_invite");
    const accepted = await call(room.baseUrl, "POST", `/j/${usedId}/accept`, {
      cookie: `commona_invite=${usedSecret}`,
      json: {},
    });
    expect(accepted.status).toBe(201);
    const used = await openWelcome(room, usedId);
    expect(used.body).toContain("This link has already been used, so ask Owner One for a new link.");
    expect(used.body).not.toContain("Sunday lunch");
    expect(used.body).not.toContain(room.roomId);
    expect(used.body).not.toContain(usedSecret);
    assertAccessible(used.body);
    assertNoJargon(used.body);
    expect(freeze(used.body, usedId)).toMatchSnapshot("used");

    const revokedId = await createInvite(room);
    const revokedDelete = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}/invites/${revokedId}`, {
      token: room.tokens.issueAgentToken("A1"),
    });
    expect(revokedDelete.status).toBe(200);
    const revoked = await openWelcome(room, revokedId);
    expect(revoked.body).toContain("This link was cancelled, so ask Owner One for a new link.");
    expect(revoked.body).not.toContain("Sunday lunch");
    expect(revoked.body).not.toContain(room.roomId);
    assertAccessible(revoked.body);
    assertNoJargon(revoked.body);
    expect(freeze(revoked.body, revokedId)).toMatchSnapshot("revoked");
  });

  it("returns JSON when the caller does not ask for HTML", async () => {
    room = await startJoinHarness();
    const id = await createInvite(room);
    const unnamed = await call(room.baseUrl, "GET", `/j/${id}`);
    expect(unnamed.contentType).toContain("json");
    expect(JSON.parse(unnamed.body)).toEqual({ ok: true });
    const plain = await createInvite(room);
    const html = await openWelcome(room, plain);
    expect(html.body).toContain("Owner One invited you to the shared room.");
    expect(html.body).not.toContain(room.roomId);
  });
});
