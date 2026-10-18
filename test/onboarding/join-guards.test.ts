import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "./harness.js";

function listedName(): string {
  const text = readFileSync(new URL("../../fixtures/names.txt", import.meta.url), "utf8");
  const name = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!name) throw new Error("fixtures/names.txt has no name");
  return name;
}

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
    const created = await createInvite(room);
    const id = created.id;
    const welcome = await call(room.baseUrl, "GET", created.openPath, { accept: "text/html" });
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

  it("rejects a protected name before it is stored as a display name", async () => {
    room = await startJoinHarness();
    const blocked = listedName();
    const created = await createInvite(room);
    const id = created.id;
    const welcome = await call(room.baseUrl, "GET", created.openPath, { accept: "text/html" });
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    const rejected = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: blocked },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).not.toContain(blocked);
    expect(displayNames(room)).not.toContain(blocked);

    const retryNonce = cookieValue(rejected.setCookies, "commona_form");
    const continued = await call(room.baseUrl, "POST", `/j/${id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${retryNonce}`,
      form: { nonce: retryNonce, firstName: "Alex" },
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
    expect(displayNames(room)).not.toContain(blocked);

    const laterInvite = await createInvite(room);
    const later = await call(room.baseUrl, "GET", `/j/${laterInvite.id}`, { accept: "text/html" });
    expect(later.body).not.toContain(blocked);
  });
});
