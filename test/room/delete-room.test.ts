import { afterEach, describe, expect, it } from "vitest";
import { call, createInvite, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";

describe("room delete", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("refuses the creator's narrow sharing key and audits the refusal", async () => {
    room = await startJoinHarness();
    const creator = room.tokens.authenticate(room.owner);
    expect(creator?.kind).toBe("owner");
    const sharingKey = room.tokens.issueNarrowToken(creator!.ownerId);
    const before = room.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };

    const deleted = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}`, { token: sharingKey });
    expect(deleted.status).toBe(403);
    expect(JSON.parse(deleted.body)).toEqual({
      error: { code: "forbidden", message: "Not allowed.", reason: "not_owner" },
    });
    expect(room.db.prepare("SELECT id FROM rooms WHERE id = ?").get(room.roomId)).toBeDefined();
    expect(room.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: before.n + 1 });
    const refusal = room.db
      .prepare("SELECT room, agent_id, owner_id, action, result, detail_json FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get();
    expect(refusal).toEqual({
      room: room.roomId,
      agent_id: "narrow",
      owner_id: creator!.ownerId,
      action: "setting_change_refused",
      result: "refused",
      detail_json: JSON.stringify({ itemId: room.roomId, reasonCode: "not_owner" }),
    });
  });

  it("purges pending sharing flashes when the owner deletes the room", async () => {
    room = await startJoinHarness();
    const invite = await createInvite(room);
    const secret = invite.openPath.split("/")[3] ?? "";
    const redeemed = await call(room.baseUrl, "GET", `/r/${room.roomId}/${invite.id}/${secret}`, {
      accept: "text/html",
    });
    expect(redeemed.status).toBe(303);
    expect(redeemed.location).toBe(`/r/${room.roomId}`);
    expect(room.db.prepare("SELECT COUNT(*) AS n FROM room_sharing_flash WHERE room_id = ?").get(room.roomId)).toEqual({
      n: 1,
    });

    const deleted = await call(room.baseUrl, "DELETE", `/rooms/${room.roomId}`, { token: room.owner });
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toMatchObject({ deleted: true });
    expect(room.db.prepare("SELECT id FROM rooms WHERE id = ?").get(room.roomId)).toBeUndefined();
    for (const table of ["room_sharing_flash", "room_key_flash", "memberships", "sharing", "invites"]) {
      expect(room.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(room.roomId)).toEqual({ n: 0 });
    }
  });
});
