import { afterEach, describe, expect, it } from "vitest";
import { ownerActorId, SharingLevel } from "../../contract/index.js";
import { rememberHostGrant } from "../../src/room/host-grant.js";
import { call, cookieValue, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

const HOST_NOTE = "Host note about napkins";
const OTHER_NOTE = "Other owner note about cups";
const HOST_FILE = "napkins.txt";
const HOST_FILE_BYTES = "napkin-list";
const NOW = "2026-04-01T12:00:00.000Z";

describe("host Messages grant on invite redeem", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("applies the host's remembered Messages grant on the API join", async () => {
    room = await startJoinHarness();
    rememberHostGrant(room.db, room.roomId, "O1");
    seedNotes(room);

    const joined = await joinByApi(room);

    expect(room.sharing.level(room.roomId, "O1", joined.ownerId)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O2", joined.ownerId)).toBe(SharingLevel.None);
    expect(levels(room)).not.toContain(SharingLevel.MessagesFiles);
    expect(joined.posts.map((post) => post.text)).toContain(HOST_NOTE);
    expect(joined.posts.map((post) => post.text)).not.toContain(OTHER_NOTE);
    expect(hostGrants(room, joined.ownerId)).toEqual([
      { fromOwnerId: "O1", toOwnerId: joined.ownerId, level: SharingLevel.Messages },
    ]);

    const file = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/files/file_host_note`, {
      token: joined.agentKey,
    });
    expect(file.status).toBe(404);
    expect(file.body.includes(HOST_FILE_BYTES)).toBe(false);
    const feed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: joined.agentKey });
    expect(feed.body).toContain(HOST_NOTE);
    expect(feed.body.includes(OTHER_NOTE)).toBe(false);
    expect(feed.body.includes(HOST_FILE)).toBe(false);
  });

  it("does not grant Messages when the host remembered nothing", async () => {
    room = await startJoinHarness();
    seedNotes(room);

    const joined = await joinByApi(room);

    expect(room.sharing.level(room.roomId, "O1", joined.ownerId)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, "O2", joined.ownerId)).toBe(SharingLevel.None);
    expect(joined.posts.map((post) => post.text)).not.toContain(HOST_NOTE);
    expect(joined.posts.map((post) => post.text)).not.toContain(OTHER_NOTE);
    expect(hostGrants(room, joined.ownerId)).toEqual([]);
  });

  it("applies that same grant once on the guided join and does not open the joiner's posts", async () => {
    room = await startJoinHarness();
    rememberHostGrant(room.db, room.roomId, "O1");
    const created = await createInvite(room);
    const welcome = await call(room.baseUrl, "GET", created.openPath, { accept: "text/html" });
    const invite = cookieValue(welcome.setCookies, "commona_invite");
    const welcomeNonce = cookieValue(welcome.setCookies, "commona_form");
    const continued = await call(room.baseUrl, "POST", `/j/${created.id}/continue`, {
      cookie: `commona_invite=${invite}; commona_form=${welcomeNonce}`,
      form: { nonce: welcomeNonce, firstName: "Blair" },
    });
    expect(continued.status).toBe(303);
    const sharing = await call(room.baseUrl, "GET", `/j/${created.id}/sharing`, {
      accept: "text/html",
      cookie: `commona_invite=${invite}`,
    });
    const shareNonce = cookieValue(sharing.setCookies, "commona_form");
    const finished = await call(room.baseUrl, "POST", `/j/${created.id}/finish`, {
      cookie: `commona_invite=${invite}; commona_form=${shareNonce}`,
      form: { nonce: shareNonce },
    });
    expect(finished.status).toBe(303);

    const owner = room.db.prepare("SELECT id FROM owners WHERE display_name = ?").get("Blair") as { id: string };
    expect(room.sharing.level(room.roomId, "O1", owner.id)).toBe(SharingLevel.Messages);
    expect(room.sharing.level(room.roomId, "O2", owner.id)).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, owner.id, "O1")).toBe(SharingLevel.None);
    expect(room.sharing.level(room.roomId, owner.id, "O2")).toBe(SharingLevel.None);
    expect(hostGrants(room, owner.id)).toEqual([
      { fromOwnerId: "O1", toOwnerId: owner.id, level: SharingLevel.Messages },
    ]);
  });
});

async function joinByApi(room: JoinHarness): Promise<{ ownerId: string; agentKey: string; posts: { text: string }[] }> {
  const invite = await createInvite(room);
  const secret = invite.openPath.split("/")[3] ?? "";
  const opened = await call(room.baseUrl, "GET", `/api/j/${invite.id}/${secret}`);
  expect(opened.status).toBe(200);
  const body = JSON.parse(opened.body) as { ownerId: string; agentKey: string; posts: { text: string }[] };
  expect(opened.body.includes(secret)).toBe(false);
  return body;
}

function seedNotes(room: JoinHarness): void {
  insertPost(room, "post_host_note", "A1", "O1", HOST_NOTE);
  insertPost(room, "post_other_note", "A2", "O2", OTHER_NOTE);
  const bytes = Buffer.from(HOST_FILE_BYTES);
  room.db
    .prepare(
      `INSERT INTO files (
         id, room_id, author_agent_id, author_owner_id, name, media_type, content, metadata_json,
         byte_length, round, held, block_category, block_location, created_at
       ) VALUES (?, ?, 'A1', 'O1', ?, 'text/plain', ?, '{}', ?, 1, 0, NULL, NULL, ?)`,
    )
    .run("file_host_note", room.roomId, HOST_FILE, bytes, bytes.length, NOW);
}

function insertPost(room: JoinHarness, id: string, agentId: string, ownerId: string, text: string): void {
  room.db
    .prepare(
      `INSERT INTO posts (
         id, room_id, author_agent_id, author_owner_id, text, reply_to_id, thread_id, round, held,
         block_category, block_location, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run(id, room.roomId, agentId, ownerId, text, id, NOW);
}

function levels(room: JoinHarness): string[] {
  const rows = room.db.prepare("SELECT level FROM sharing WHERE room_id = ?").all(room.roomId) as { level: string }[];
  return rows.map((row) => row.level);
}

function hostGrants(room: JoinHarness, toOwnerId: string): { fromOwnerId: string; toOwnerId: string; level: string }[] {
  const rows = room.db
    .prepare(
      `SELECT detail_json FROM audit_log
       WHERE action = 'setting_change' AND result = 'ok' AND agent_id = ? AND owner_id = ?`,
    )
    .all(ownerActorId("O1"), "O1") as { detail_json: string }[];
  return rows.flatMap((row) => {
    const detail = JSON.parse(row.detail_json) as { level?: string; fromOwnerId?: string; toOwnerId?: string };
    if (detail.fromOwnerId !== "O1" || detail.toOwnerId !== toOwnerId) return [];
    return [{ fromOwnerId: "O1", toOwnerId, level: detail.level ?? "" }];
  });
}
