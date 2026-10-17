import { afterEach, describe, expect, it } from "vitest";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "./harness.js";

function displayNames(room: JoinHarness): string[] {
  return (room.db.prepare("SELECT display_name FROM owners").all() as { display_name: string }[]).map(
    (row) => row.display_name,
  );
}

describe("join name guards", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("refuses a pending name from a browser that does not hold the invite cookie", async () => {
    room = await startJoinHarness();
    const id = await createInvite(room);
    const welcome = await call(room.baseUrl, "GET", `/j/${id}`, { accept: "text/html" });
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");

    const stranger = await call(room.baseUrl, "GET", `/j/${id}`, { accept: "text/html" });
    const strangerNonce = cookieValue(stranger.setCookies, "commona_form");
    expect(cookieValue(stranger.setCookies, "commona_invite")).toBe("");
    const overwritten = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_form=${strangerNonce}`,
      form: { nonce: strangerNonce, firstName: "Pat" },
    });
    expect(overwritten.status).toBe(403);
    expect(overwritten.body).not.toContain("Pat");

    const forged = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=not-the-secret; commona_form=${strangerNonce}`,
      form: { nonce: strangerNonce, firstName: "Pat" },
    });
    expect(forged.status).toBe(403);
    expect(displayNames(room)).not.toContain("Pat");

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
      form: { nonce: shareNonce, seeing: "Nothing" },
    });
    expect(finished.status).toBe(303);
    expect(displayNames(room)).toContain("Alex");
    expect(displayNames(room)).not.toContain("Pat");
  });

  it("stores a display name that includes the invented patient name", async () => {
    room = await startJoinHarness();
    const name = "Jane Testpatient";
    const id = await createInvite(room);
    const welcome = await call(room.baseUrl, "GET", `/j/${id}`, { accept: "text/html" });
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    const continued = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: name },
    });
    expect(continued.status).toBe(303);
    const sharing = await call(room.baseUrl, "GET", `/j/${id}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${id}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce, seeing: "Nothing" },
    });
    expect(finished.status).toBe(303);
    expect(displayNames(room)).toContain(name);
  });
});
