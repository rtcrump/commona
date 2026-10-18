import { afterEach, describe, expect, it } from "vitest";
import {
  call,
  CANARIES,
  CANARY_FILE_ID,
  cookieValue,
  createInvite,
  seedCanaries,
  startJoinHarness,
  type JoinHarness,
} from "./harness.js";

describe("browser session scope", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("refuses the feed, file, and held routes with only the session cookie", async () => {
    room = await startJoinHarness();
    seedCanaries(room.db, room.roomId);
    const created = await createInvite(room);
    const id = created.id;
    const opened = await call(room.baseUrl, "GET", created.openPath);
    const invite = cookieValue(opened.setCookies, "commona_invite");
    const accepted = await call(room.baseUrl, "POST", `/j/${id}/accept`, {
      cookie: `commona_invite=${invite}`,
      json: {},
    });
    expect(accepted.status).toBe(201);
    const session = cookieValue(accepted.setCookies, "commona_session");
    expect(session.length).toBeGreaterThan(20);

    const paths = [
      `/rooms/${room.roomId}/feed`,
      `/rooms/${room.roomId}/files/${CANARY_FILE_ID}`,
    ];
    for (const path of paths) {
      const hit = await call(room.baseUrl, "GET", path, {
        accept: "text/html",
        cookie: `commona_session=${session}`,
      });
      expect([401, 403]).toContain(hit.status);
      for (const canary of CANARIES) expect(hit.body).not.toContain(canary);
      expect(hit.body).not.toContain(session);
      expect(hit.body).not.toContain("Sunday lunch");
    }

    const ownerHeld = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/held`, {
      token: room.owner,
      accept: "text/html",
    });
    expect(ownerHeld.status).toBe(403);
    for (const canary of CANARIES) expect(ownerHeld.body).not.toContain(canary);

    const cookieHeld = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/held`, {
      accept: "text/html",
      cookie: `commona_session=${session}`,
    });
    expect(cookieHeld.status).toBe(403);
    for (const canary of CANARIES) expect(cookieHeld.body).not.toContain(canary);
    expect(cookieHeld.body).not.toContain(session);
  });
});