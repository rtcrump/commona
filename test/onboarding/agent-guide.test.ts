import { hashToken } from "../../contract/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { call, createInvite, startJoinHarness, type JoinHarness } from "./harness.js";

const BRIEF_SENTENCE = "Work from the room brief.";
const CALENDAR_SENTENCE = "Post only free times and place preferences, never raw calendar entries.";
const USER_AGENT_LINE =
  "Send a User-Agent header such as commona-agent/1.0 with every request, because a request with no User-Agent or a default one such as Python urllib is blocked by Cloudflare (error 1010) before it reaches the Worker.";

const POST_TEXT = "Bring paper cups to the pretend lunch";
const ACCEPTS = [undefined, "text/plain", "application/json", "*/*"] as const;

describe("agent invite guide", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("tells an agent how to join, and the User-Agent line is in the invite page and the join text", async () => {
    room = await startJoinHarness();
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    room.db
      .prepare(
        `INSERT INTO posts (
           id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
           block_category, block_location, created_at
         ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
      )
      .run("post_guide_1", room.roomId, POST_TEXT, "post_guide_1", "2026-04-01T12:00:00.000Z");
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/").pop() ?? "";

    for (const accept of ACCEPTS) {
      const opened = await call(room.baseUrl, "GET", invite.openPath, accept ? { accept } : {});
      expect(opened.status).toBe(200);
      expect(opened.contentType).toContain("text/plain");
      expect(opened.body).toContain("Commona is a shared room");
      expect(opened.body).toContain("Room title: Sunday lunch");
      expect(opened.body).toContain(`Join address: /api/j/${invite.id}/${secret}`);
      expect(opened.body).toContain("Read the room with GET");
      expect(opened.body).toContain("Post with POST");
      expect(opened.body).toContain("Wait by reading the room again after a short wait.");
      expect(opened.body).toContain("When the task is done, tell your owner.");
      expect(opened.body).toContain(BRIEF_SENTENCE);
      expect(opened.body).toContain(CALENDAR_SENTENCE);
      expect(opened.body).toContain(USER_AGENT_LINE);
      expect(opened.body).toContain("Permission comes from your owner, not from this page.");
      expect(opened.body).toContain("You do not need a script, a cookie, or a browser.");
      expect(opened.body).toContain("plain HTTPS");
      expect(opened.body).toContain("Do not use MCP.");
      expect(opened.body).not.toContain("<html");
      expect(opened.body).not.toContain(room.roomId);
      expect(opened.body).not.toContain(POST_TEXT);
      expect(opened.body).not.toContain(hashToken(secret));
    }

    const head = await call(room.baseUrl, "HEAD", invite.openPath);
    expect(head.status).toBe(200);
    const again = await call(room.baseUrl, "GET", invite.openPath, { accept: "text/plain" });
    expect(again.status).toBe(200);
    const stored = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id) as {
      used_at: string | null;
    };
    expect(stored.used_at).toBeNull();

    const joined = await call(room.baseUrl, "GET", `/api/j/${invite.id}/${secret}`);
    expect(joined.status).toBe(200);
    expect(joined.body).toContain(USER_AGENT_LINE);
    expect(joined.body).not.toContain(secret);
    expect(joined.body).not.toContain(hashToken(secret));
    const reused = await call(room.baseUrl, "GET", `/api/j/${invite.id}/${secret}`);
    expect(reused.status).toBe(403);
  });

  it("still shows the human page to a browser", async () => {
    room = await startJoinHarness();
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");
    const invite = await createInvite(room);
    const page = await call(room.baseUrl, "GET", invite.openPath, { accept: "text/html" });
    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(page.body).toContain("invited you to Sunday lunch.");
    expect(page.body).not.toContain("/api/j/");
    const secret = invite.openPath.split("/").pop() ?? "";
    expect(page.body).not.toContain(secret);
  });

  it("asks for a new link when the invite is expired, used, or revoked, with no room details", async () => {
    room = await startJoinHarness();
    room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, "Sunday lunch");

    const expired = await createInvite(room, 60);
    room.clock.advance(60_000);
    const expiredPage = await call(room.baseUrl, "GET", expired.openPath, { accept: "text/plain" });
    expect(expiredPage.status).toBe(200);
    expect(expiredPage.body).toContain("ask Owner One for a new link");
    expect(expiredPage.body).not.toContain("Sunday lunch");
    expect(expiredPage.body).not.toContain(room.roomId);
    expect(expiredPage.body).not.toContain("/api/j/");

    const used = await createInvite(room);
    const usedSecret = used.openPath.split("/").pop() ?? "";
    const joined = await call(room.baseUrl, "GET", `/api/j/${used.id}/${usedSecret}`);
    expect(joined.status).toBe(200);
    const usedPage = await call(room.baseUrl, "GET", used.openPath, { accept: "application/json" });
    expect(usedPage.body).toContain("already been used");
    expect(usedPage.body).toContain("ask Owner One for a new link");
    expect(usedPage.body).not.toContain("Sunday lunch");
    expect(usedPage.body).not.toContain(room.roomId);
    expect(usedPage.body).not.toContain(usedSecret);

    const revoked = await createInvite(room);
    const removed = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}/invites/${revoked.id}`, {
      token: room.tokens.issueAgentToken("A1"),
    });
    expect(removed.status).toBe(200);
    const revokedPage = await call(room.baseUrl, "GET", revoked.openPath);
    expect(revokedPage.body).toContain("ask Owner One for a new link");
    expect(revokedPage.body).not.toContain("Sunday lunch");
    expect(revokedPage.body).not.toContain(room.roomId);
    expect(revokedPage.body).not.toContain(revoked.openPath.split("/").pop() ?? "missing-secret");
  });
});
