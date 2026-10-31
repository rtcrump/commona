import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { claimAgentHandoff, issueAgentHandoff } from "../../src/onboarding/handoff.js";
import { agentCookieName } from "../../src/room-page/routes.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const NOTE = "Bring napkins";

describe("agent json api", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("joins once, returns the agent key once, and stores only the hash", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    nameRoom(room, "Sunday lunch");
    seedHostPost(room, "Host note about napkins");
    const secret = secretOf(invite.openPath);

    const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}?t=${secret}`);
    expect(opened.status).toBe(200);
    expect(opened.location).toBeNull();
    expect(opened.contentType).toContain("application/json");
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.roomId).toBe(room.roomId);
    expect(joined.title).toBe("Sunday lunch");
    expect(joined.posts).toEqual([]);
    expect(joined.agentId).toMatch(/^agent_/);
    expect(/^[A-Za-z0-9_-]{20,}$/.test(joined.agentKey)).toBe(true);
    expect(opened.body.includes(secret)).toBe(false);
    expect(opened.body.includes(hashToken(secret))).toBe(false);
    expect(opened.body.includes(hashToken(joined.agentKey))).toBe(false);

    const stored = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(joined.agentId) as {
      token_hash: string;
    };
    expect(stored.token_hash).toBe(hashToken(joined.agentKey));
    expect(stored.token_hash).not.toBe(joined.agentKey);
    expect(auditText(room).includes(secret)).toBe(false);
    expect(auditText(room).includes(joined.agentKey)).toBe(false);
    expect(auditActions(room)).toContain("join");

    const again = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, {
      token: joined.agentKey,
    });
    expect(again.status).toBe(200);
    expect(again.body.includes(joined.agentKey)).toBe(false);
    expect(JSON.parse(again.body)).toEqual({
      roomId: room.roomId,
      title: "Sunday lunch",
      posts: [],
      brief: null,
    });

    const reused = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secret}`);
    expect(reused.status).toBe(403);
    expect(reused.body.includes(secret)).toBe(false);
    expect(reused.body.includes(joined.agentKey)).toBe(false);
  });

  it("does not redeem an invite on HEAD or POST", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const path = `/api/r/${room.roomId}/${invite.id}/${secret}`;

    const head = await call(room.baseUrl, "HEAD", path);
    expect(head.status).toBe(200);
    expect(head.body.includes(secret)).toBe(false);
    expect(usedAt(room, invite.id)).toBeNull();

    const posted = await call(room.baseUrl, "POST", path, { json: { text: NOTE } });
    expect(posted.status).toBe(404);
    expect(usedAt(room, invite.id)).toBeNull();

    const queryPost = await call(room.baseUrl, "POST", `/api/r/${room.roomId}?t=${secret}`, {
      json: { text: NOTE },
    });
    expect(queryPost.status).toBe(401);
    expect(usedAt(room, invite.id)).toBeNull();

    const opened = await call(room.baseUrl, "GET", path);
    expect(opened.status).toBe(200);
    const joined = JSON.parse(opened.body) as Joined;
    expect(joined.agentKey.length).toBeGreaterThan(20);
    expect(opened.body.includes(secret)).toBe(false);
  });

  it("posts with the bearer key and audits the post", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: joined.agentKey,
      json: { text: NOTE },
    });
    expect(posted.status).toBe(201);
    const body = JSON.parse(posted.body) as { outcome: string; post: { text: string } };
    expect(body.outcome).toBe("accepted");
    expect(body.post.text).toBe(NOTE);

    const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: joined.agentKey });
    expect(JSON.parse(read.body)).toMatchObject({ posts: [{ text: NOTE }] });
    const feed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: joined.agentKey });
    expect(feed.status).toBe(200);
    expect(feed.body).toContain(NOTE);

    const rows = room.db.prepare("SELECT action, result FROM audit_log WHERE action = 'post'").all() as {
      action: string;
      result: string;
    }[];
    expect(rows).toEqual([{ action: "post", result: "ok" }]);
    expect(auditText(room).includes(joined.agentKey)).toBe(false);
  });

  it("lets the room owner revoke the key, then the json api and the form return 401", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = secretOf(invite.openPath);
    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secret}`);
    expect(opened.status).toBe(303);
    const cookieName = agentCookieName(room.roomId);
    const key = cookieValue(opened.setCookies, cookieName);
    const landed = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${cookieName}=${key}` });
    const nonce = nonceOf(landed.body);
    const agent = room.db.prepare("SELECT id FROM agents WHERE token_hash = ?").get(hashToken(key)) as { id: string };

    const stranger = room.tokens.issueOwnerToken("O2");
    const refused = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${agent.id}`, {
      token: stranger,
    });
    expect(refused.status).toBe(403);
    const still = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agent.id) as {
      token_hash: string | null;
    };
    expect(still.token_hash).toBe(hashToken(key));

    const guest = await join(room);
    const guestRevoke = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${agent.id}`, {
      token: guest.agentKey,
    });
    expect(guestRevoke.status).toBe(403);

    const revoked = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${agent.id}`, {
      token: room.owner,
    });
    expect(revoked.status).toBe(200);
    expect(JSON.parse(revoked.body)).toEqual({ revoked: true });
    const cleared = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agent.id) as {
      token_hash: string | null;
    };
    const hashed = room.db
      .prepare("SELECT token_hash FROM agent_key_revocations WHERE agent_id = ?")
      .get(agent.id) as { token_hash: string };
    expect(cleared.token_hash).toBeNull();
    expect(hashed.token_hash).toBe(hashToken(key));
    expect(JSON.stringify(hashed).includes(key)).toBe(false);

    const jsonPost = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: key,
      json: { text: NOTE },
    });
    expect(jsonPost.status).toBe(401);
    const jsonRead = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: key });
    expect(jsonRead.status).toBe(401);
    const legacy = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/posts`, {
      token: key,
      json: { text: NOTE },
    });
    expect(legacy.status).toBe(401);
    const feed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: key });
    expect(feed.status).toBe(401);

    const form = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${cookieName}=${key}`,
      form: { nonce, text: NOTE },
    });
    expect(form.status).toBe(401);
    expect(form.body).toContain("This key was revoked.");
    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${cookieName}=${key}` });
    expect(page.status).toBe(401);

    const audit = room.db
      .prepare("SELECT action, result FROM audit_log WHERE action = 'setting_change' OR action = 'setting_change_refused'")
      .all() as { action: string; result: string }[];
    expect(audit).toContainEqual({ action: "setting_change", result: "ok" });
    expect(audit.some((row) => row.action === "setting_change_refused")).toBe(true);
    expect(auditText(room).includes(key)).toBe(false);
    expect(auditText(room).includes(secret)).toBe(false);
  });

  it("returns 429 after 30 posts in an hour and allows a post when the hour has passed", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const opened = await call(room.baseUrl, "GET", `/r/${room.roomId}?t=${secretOf(invite.openPath)}`);
    expect(opened.status).toBe(303);
    const cookieName = agentCookieName(room.roomId);
    const key = cookieValue(opened.setCookies, cookieName);
    const landed = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${cookieName}=${key}` });
    const nonce = nonceOf(landed.body);
    const agent = room.db.prepare("SELECT id FROM agents WHERE token_hash = ?").get(hashToken(key)) as { id: string };

    for (let index = 0; index < 29; index += 1) {
      const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
        token: key,
        json: { text: `${NOTE} ${index}` },
      });
      expect(posted.status).toBe(201);
    }
    const form = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${cookieName}=${key}`,
      form: { nonce, text: NOTE },
    });
    expect(form.status).toBe(303);
    expect(hitCount(room, agent.id)).toBe(30);

    const page = await call(room.baseUrl, "GET", `/r/${room.roomId}`, { cookie: `${cookieName}=${key}` });
    const limitedForm = await call(room.baseUrl, "POST", `/r/${room.roomId}`, {
      cookie: `${cookieName}=${key}`,
      form: { nonce: nonceOf(page.body), text: NOTE },
    });
    expect(limitedForm.status).toBe(429);
    expect(limitedForm.retryAfter).toBe("3600");
    expect(limitedForm.body).toContain("Try again later.");

    const limited = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: key,
      json: { text: NOTE },
    });
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBe("3600");
    expect(JSON.parse(limited.body)).toEqual({ error: { code: "validation", message: "Try again later." } });
    expect(hitCount(room, agent.id)).toBe(30);
    expect(postCount(room)).toBe(30);
    const refused = room.db
      .prepare("SELECT action, result, detail_json FROM audit_log WHERE result = 'refused' AND action = 'post'")
      .all() as { action: string; result: string; detail_json: string }[];
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(refused[0]?.detail_json).toContain("429");
    expect(auditText(room).includes(key)).toBe(false);

    room.clock.advance(60 * 60 * 1000);
    const later = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: key,
      json: { text: "Bring forks" },
    });
    expect(later.status).toBe(201);
    expect(postCount(room)).toBe(31);
  });

  it("blocks reissue after revoke until the room owner sends a new invite", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const key = joined.agentKey;
    const agent = room.db.prepare("SELECT id, owner_id FROM agents WHERE id = ?").get(joined.agentId) as {
      id: string;
      owner_id: string;
    };
    const agentOwner = room.tokens.issueOwnerToken(agent.owner_id);

    const revoked = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${agent.id}`, {
      token: room.owner,
    });
    expect(revoked.status).toBe(200);

    const blocked = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/members`, {
      token: agentOwner,
      json: { agentId: agent.id },
    });
    expect(blocked.status).toBe(403);
    const refusedJoin = room.db
      .prepare("SELECT action, result, agent_id, owner_id FROM audit_log WHERE action = 'join_refused'")
      .all() as { action: string; result: string; agent_id: string; owner_id: string }[];
    expect(refusedJoin).toEqual([
      { action: "join_refused", result: "refused", agent_id: `owner:${agent.owner_id}`, owner_id: agent.owner_id },
    ]);
    const handoffDeps = { db: room.db, clock: room.clock, tokens: room.tokens };
    const handoff = issueAgentHandoff(handoffDeps, agent.owner_id);
    expect(() => claimAgentHandoff(handoffDeps, handoff.secret)).toThrow(/unusable/);
    const still = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agent.id) as {
      token_hash: string | null;
    };
    expect(still.token_hash).toBeNull();
    await expect401(room, key);

    const guestOwner = room.tokens.issueOwnerToken("O2");
    const guestInvite = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/invites`, {
      token: guestOwner,
      json: {},
    });
    expect(guestInvite.status).toBe(201);
    const stillBlocked = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/members`, {
      token: agentOwner,
      json: { agentId: agent.id },
    });
    expect(stillBlocked.status).toBe(403);

    const restored = await createInvite(room);
    expect(restored.id.length).toBeGreaterThan(0);
    const claimed = claimAgentHandoff(handoffDeps, handoff.secret);
    const key2 = claimed.credential;
    expect(key2).not.toBe(key);
    await expect401(room, key);
    const live = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: key2 });
    expect(live.status).toBe(200);

    const revokedAgain = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${agent.id}`, {
      token: room.owner,
    });
    expect(revokedAgain.status).toBe(200);
    await expect401(room, key);
    await expect401(room, key2);
    const hashes = room.db
      .prepare("SELECT token_hash FROM agent_key_revocations WHERE agent_id = ? ORDER BY token_hash")
      .all(agent.id) as { token_hash: string }[];
    expect(hashes.map((row) => row.token_hash).sort()).toEqual([hashToken(key), hashToken(key2)].sort());
    const audits = room.db
      .prepare("SELECT action, result FROM audit_log WHERE action = 'setting_change' AND detail_json LIKE ?")
      .all(`%${agent.id}%`) as { action: string; result: string }[];
    expect(audits).toEqual([
      { action: "setting_change", result: "ok" },
      { action: "setting_change", result: "ok" },
    ]);
    expect(auditText(room).includes(key)).toBe(false);
    expect(auditText(room).includes(key2)).toBe(false);
  });

  it("revokes a key that was forced out after an earlier revoke", async () => {
    room = await startJoinHarness();
    const joined = await join(room);
    const key = joined.agentKey;
    const first = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${joined.agentId}`, {
      token: room.owner,
    });
    expect(first.status).toBe(200);

    const rotated = room.tokens.issueAgentToken(joined.agentId);
    const usingRotated = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: rotated });
    expect(usingRotated.status).toBe(200);

    const second = await call(room.baseUrl, "DELETE", `/api/r/${room.roomId}/agents/${joined.agentId}`, {
      token: room.owner,
    });
    expect(second.status).toBe(200);
    await expect401(room, key);
    await expect401(room, rotated);
    const cleared = room.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(joined.agentId) as {
      token_hash: string | null;
    };
    expect(cleared.token_hash).toBeNull();
    const hashes = room.db
      .prepare("SELECT token_hash FROM agent_key_revocations WHERE agent_id = ?")
      .all(joined.agentId) as { token_hash: string }[];
    expect(hashes.map((row) => row.token_hash).sort()).toEqual([hashToken(key), hashToken(rotated)].sort());
  });
});

interface Joined {
  roomId: string;
  agentId: string;
  title: string;
  posts: { text: string }[];
  agentKey: string;
}

async function expect401(room: JoinHarness, key: string): Promise<void> {
  const read = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: key });
  expect(read.status).toBe(401);
  const posted = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, { token: key, json: { text: NOTE } });
  expect(posted.status).toBe(401);
}

async function join(room: JoinHarness): Promise<Joined> {
  const invite = await createInvite(room);
  const opened = await call(room.baseUrl, "GET", `/api/r/${room.roomId}/${invite.id}/${secretOf(invite.openPath)}`);
  expect(opened.status).toBe(200);
  return JSON.parse(opened.body) as Joined;
}

function nameRoom(room: JoinHarness, title: string): void {
  room.db.prepare("INSERT INTO room_titles (room_id, title) VALUES (?, ?)").run(room.roomId, title);
}

function seedHostPost(room: JoinHarness, text: string): void {
  room.db
    .prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, 'A1', 'O1', ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run("post_agent_api_host", room.roomId, text, "post_agent_api_host", "2026-04-01T12:00:00.000Z");
}

function secretOf(openPath: string): string {
  return openPath.split("/")[3] ?? "";
}

function nonceOf(html: string): string {
  return html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? "";
}

function usedAt(room: JoinHarness, inviteId: string): string | null {
  const row = room.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(inviteId) as { used_at: string | null };
  return row.used_at;
}

function hitCount(room: JoinHarness, agentId: string): number {
  const row = room.db.prepare("SELECT COUNT(*) AS n FROM agent_post_hits WHERE agent_id = ?").get(agentId) as {
    n: number;
  };
  return Number(row.n);
}

function postCount(room: JoinHarness): number {
  const row = room.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE room_id = ? AND held = 0").get(room.roomId) as {
    n: number;
  };
  return Number(row.n);
}

function auditActions(room: JoinHarness): string[] {
  const rows = room.db.prepare("SELECT action FROM audit_log").all() as { action: string }[];
  return rows.map((row) => row.action);
}

function auditText(room: JoinHarness): string {
  const rows = room.db.prepare("SELECT detail_json, agent_id, owner_id FROM audit_log").all() as {
    detail_json: string;
    agent_id: string;
    owner_id: string;
  }[];
  return JSON.stringify(rows);
}
