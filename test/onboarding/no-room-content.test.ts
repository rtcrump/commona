import { afterEach, describe, expect, it } from "vitest";
import { call, CANARIES, cookieValue, createInvite, seedCanaries, startJoinHarness, type JoinHarness } from "./harness.js";

function assertClean(text: string, roomId: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
  expect(text).not.toContain(roomId);
  expect(text.toLowerCase()).not.toContain("<script");
}

describe("join pages show no room content", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("keeps canary posts, file names, and held text off every HTML page", async () => {
    room = await startJoinHarness();
    seedCanaries(room.db, room.roomId);
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const pages: string[] = [];

    const welcomeId = await createInvite(room);
    const welcome = await call(room.baseUrl, "GET", `/j/${welcomeId}`, { accept: "text/html" });
    expect(welcome.status).toBe(200);
    expect(welcome.contentType).toContain("text/html");
    expect(welcome.body).toContain("Sunday lunch");
    pages.push(welcome.body);

    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    const continued = await call(room.baseUrl, "POST", `/j/${welcomeId}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: "Alex" },
    });
    pages.push(continued.body, continued.location ?? "");

    const sharing = await call(room.baseUrl, "GET", `/j/${welcomeId}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    expect(sharing.status).toBe(200);
    pages.push(sharing.body);

    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${welcomeId}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce, seeing: "Nothing" },
    });
    pages.push(finished.body, finished.location ?? "");
    const joined = cookieValue(finished.setCookies, "commona_joined");

    const done = await call(room.baseUrl, "GET", `/j/${welcomeId}/done`, {
      accept: "text/html",
      cookie: `commona_joined=${joined}`,
    });
    expect(done.body).toContain("You're in.");
    pages.push(done.body);

    const connect = await call(room.baseUrl, "GET", "/join/connect", { accept: "text/html" });
    pages.push(connect.body);

    const staleId = await createInvite(room);
    const stale = await call(room.baseUrl, "POST", `/j/${staleId}/continue`, { form: { firstName: "Alex" } });
    expect(stale.status).toBe(403);
    pages.push(stale.body);

    const expiredId = await createInvite(room, 60);
    room.clock.advance(60_000);
    const expired = await call(room.baseUrl, "GET", `/j/${expiredId}`, { accept: "text/html" });
    expect(expired.body).toContain("expired");
    expect(expired.body).not.toContain("Sunday lunch");
    pages.push(expired.body);

    const usedId = await createInvite(room);
    const usedGet = await call(room.baseUrl, "GET", `/j/${usedId}`);
    const usedSecret = cookieValue(usedGet.setCookies, "commona_invite");
    await call(room.baseUrl, "POST", `/j/${usedId}/accept`, { cookie: `commona_invite=${usedSecret}`, json: {} });
    const used = await call(room.baseUrl, "GET", `/j/${usedId}`, { accept: "text/html" });
    expect(used.body).toContain("already been used");
    expect(used.body).not.toContain("Sunday lunch");
    pages.push(used.body);

    const revokedId = await createInvite(room);
    await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}/invites/${revokedId}`, {
      token: room.tokens.issueAgentToken("A1"),
    });
    const revoked = await call(room.baseUrl, "GET", `/j/${revokedId}`, { accept: "text/html" });
    expect(revoked.body).toContain("cancelled");
    expect(revoked.body).not.toContain("Sunday lunch");
    pages.push(revoked.body);

    const css = await call(room.baseUrl, "GET", "/onboarding/join.css");
    pages.push(css.body);

    for (const page of pages) assertClean(page, room.roomId);
  });
});
