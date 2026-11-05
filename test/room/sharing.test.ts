import { describe, expect, it } from "vitest";
import { AuditAction, AuditResult, type AuditRecord } from "../../contract/index.js";
import { send, startRoom } from "./server.js";

const SHARING_PREFIXES = ["/rooms", "/api/rooms"] as const;

describe.each(SHARING_PREFIXES)("sharing route %s/:roomId/sharing", (prefix) => {
  it("lets fromOwnerId change the row and audits the caller", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne } = await ownersInRoom(room);
      const changed = await send(room.baseUrl, "PUT", sharingPath(prefix, roomId), ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({
        sharing: { roomId, fromOwnerId: "O1", toOwnerId: "O2", level: "messages" },
      });
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      const row = room.audit.all().find((entry) => entry.action === AuditAction.SettingChange);
      expect(row).toMatchObject({
        agentId: "owner:O1",
        ownerId: "O1",
        result: AuditResult.Ok,
        detail: { level: "messages", fromOwnerId: "O1", toOwnerId: "O2" },
      });
    } finally {
      await room.stop();
    }
  });

  it("refuses an agent and another owner, and does not audit a bad body", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne, a1, ownerTwo } = await ownersInRoom(room);
      const before = room.audit.all().length;
      const badLevel = await send(room.baseUrl, "PUT", sharingPath(prefix, roomId), ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "public",
      });
      const sameOwner = await send(room.baseUrl, "PUT", sharingPath(prefix, roomId), ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O1",
        level: "none",
      });
      expect(badLevel.status).toBe(400);
      expect(sameOwner.status).toBe(400);
      expect(room.audit.all()).toHaveLength(before);

      const agent = await send(room.baseUrl, "PUT", sharingPath(prefix, roomId), a1, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      });
      const other = await send(room.baseUrl, "PUT", sharingPath(prefix, roomId), ownerTwo, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      });
      expect(agent.status).toBe(403);
      expect(agent.body).toMatchObject({ error: { reason: "agent_cannot_change_sharing" } });
      expect(other.status).toBe(403);
      expect(other.body).toMatchObject({ error: { reason: "not_owner" } });
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("none");
      const refused = room.audit.all().filter((entry) => entry.action === AuditAction.SettingChangeRefused);
      expect(refused.map((entry) => [entry.agentId, entry.ownerId, entry.detail.reasonCode])).toEqual([
        ["A1", "O1", "agent_cannot_change_sharing"],
        ["owner:O2", "O2", "not_owner"],
      ]);
    } finally {
      await room.stop();
    }
  });
});

describe("sharing route alias", () => {
  it("reads and changes the sharing level the same way on both paths", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne } = await ownersInRoom(room);
      const paths = bothPaths(roomId);
      const messages = { fromOwnerId: "O1", toOwnerId: "O2", level: "messages" };
      const before = room.audit.all().length;
      const written = [];
      for (const path of paths) written.push(await send(room.baseUrl, "PUT", path, ownerOne, messages));
      expect(written[0]?.status).toBe(200);
      expect(written[1]).toEqual(written[0]);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      const audits = room.audit.all().slice(before);
      expect(audits).toHaveLength(2);
      expect(auditFact(audits[0])).toEqual(auditFact(audits[1]));
      expect(auditFact(audits[0])).toMatchObject({
        room: roomId,
        agentId: "owner:O1",
        ownerId: "O1",
        action: AuditAction.SettingChange,
        result: AuditResult.Ok,
        detail: { level: "messages", fromOwnerId: "O1", toOwnerId: "O2" },
      });

      const raised = await send(room.baseUrl, "PUT", paths[1], ownerOne, {
        ...messages,
        level: "messages_files",
      });
      expect(raised.status).toBe(200);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages_files");
      const lowered = await send(room.baseUrl, "PUT", paths[0], ownerOne, { ...messages, level: "none" });
      expect(lowered.status).toBe(200);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("none");
    } finally {
      await room.stop();
    }
  });

  it("denies the same callers on both paths and writes the same audit entries", async () => {
    const room = await startRoom();
    try {
      const { roomId, ownerOne, ownerTwo, a1 } = await ownersInRoom(room);
      const paths = bothPaths(roomId);
      const narrow = room.tokens.issueNarrowToken("O1");
      const opened = await send(room.baseUrl, "PUT", paths[0], ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      });
      expect(opened.status).toBe(200);

      await expectSame(room, roomId, paths, a1, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      }, 403);
      await expectSame(room, roomId, paths, ownerTwo, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages",
      }, 403);
      await expectSame(room, roomId, paths, narrow, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      }, 403);
      await expectSame(room, roomId, paths, ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "public",
      }, 400);
      await expectSame(room, roomId, paths, ownerOne, {
        fromOwnerId: "O1",
        toOwnerId: "O1",
        level: "none",
      }, 400);
      await expectSame(room, roomId, paths, undefined, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "none",
      }, 401);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");

      const refused = room.audit.all().filter((entry) => entry.action === AuditAction.SettingChangeRefused);
      expect(refused.map((entry) => entry.detail.reasonCode)).toEqual([
        "agent_cannot_change_sharing",
        "agent_cannot_change_sharing",
        "not_owner",
        "not_owner",
        "sharing_narrow",
        "sharing_narrow",
      ]);
      expect(auditFact(refused[0])).toEqual(auditFact(refused[1]));
      expect(auditFact(refused[2])).toEqual(auditFact(refused[3]));
      expect(auditFact(refused[4])).toEqual(auditFact(refused[5]));

      const cookieBody = { fromOwnerId: "O1", toOwnerId: "O2", level: "messages" };
      const beforeCookie = room.audit.all().length;
      const viaCookie = [];
      for (const path of paths) viaCookie.push(await putSharing(room.baseUrl, path, cookieBody, { cookie: ownerOne }));
      expect(viaCookie[0]?.status).toBe(200);
      expect(viaCookie[1]).toEqual(viaCookie[0]);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      const cookieAudits = room.audit.all().slice(beforeCookie);
      expect(cookieAudits).toHaveLength(2);
      expect(auditFact(cookieAudits[0])).toEqual(auditFact(cookieAudits[1]));
      expect(auditFact(cookieAudits[0])).toMatchObject({ agentId: "owner:O1", result: AuditResult.Ok });

      const beforeBearer = room.audit.all().length;
      const mixed = [];
      for (const path of paths) {
        mixed.push(
          await putSharing(room.baseUrl, path, { fromOwnerId: "O1", toOwnerId: "O2", level: "messages_files" }, {
            token: a1,
            cookie: ownerOne,
          }),
        );
      }
      expect(mixed[0]?.status).toBe(403);
      expect(mixed[0]?.body).toMatchObject({ error: { reason: "agent_cannot_change_sharing" } });
      expect(mixed[1]).toEqual(mixed[0]);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      const mixedAudits = room.audit.all().slice(beforeBearer);
      expect(mixedAudits).toHaveLength(2);
      expect(auditFact(mixedAudits[0])).toEqual(auditFact(mixedAudits[1]));
      expect(auditFact(mixedAudits[0])).toMatchObject({
        agentId: "A1",
        detail: { reasonCode: "agent_cannot_change_sharing" },
      });

      const missing = "room_missing";
      const beforeMissing = room.audit.all().length;
      const absent = [];
      for (const path of bothPaths(missing)) {
        absent.push(await send(room.baseUrl, "PUT", path, ownerOne, cookieBody));
      }
      expect(absent[0]?.status).toBe(404);
      expect(absent[1]).toEqual(absent[0]);
      expect(room.audit.all()).toHaveLength(beforeMissing);

      const lowered = [];
      for (const path of paths) {
        const reset = await send(room.baseUrl, "PUT", path, ownerOne, cookieBody);
        expect(reset.status).toBe(200);
        expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
        lowered.push(
          await send(room.baseUrl, "PUT", path, narrow, { fromOwnerId: "O1", toOwnerId: "O2", level: "none" }),
        );
        expect(room.sharing.level(roomId, "O1", "O2")).toBe("none");
      }
      expect(lowered[0]?.status).toBe(200);
      expect(lowered[1]).toEqual(lowered[0]);
      const narrowChanges = room.audit
        .all()
        .filter((entry) => entry.action === AuditAction.SettingChange && entry.agentId === "narrow");
      expect(narrowChanges).toHaveLength(2);
      expect(auditFact(narrowChanges[0])).toEqual(auditFact(narrowChanges[1]));
      expect(auditFact(narrowChanges[0])).toMatchObject({
        ownerId: "O1",
        result: AuditResult.Ok,
        detail: { level: "none", fromOwnerId: "O1", toOwnerId: "O2" },
      });
    } finally {
      await room.stop();
    }
  });
});

function sharingPath(prefix: (typeof SHARING_PREFIXES)[number], roomId: string): string {
  return `${prefix}/${roomId}/sharing`;
}

function bothPaths(roomId: string): [string, string] {
  return [sharingPath("/rooms", roomId), sharingPath("/api/rooms", roomId)];
}

function auditFact(entry: AuditRecord | undefined): {
  room: string;
  agentId: string;
  ownerId: string;
  action: string;
  result: string;
  detail: AuditRecord["detail"];
} {
  if (!entry) throw new Error("missing audit entry");
  return {
    room: entry.room,
    agentId: entry.agentId,
    ownerId: entry.ownerId,
    action: entry.action,
    result: entry.result,
    detail: entry.detail,
  };
}

async function expectSame(
  room: Awaited<ReturnType<typeof startRoom>>,
  roomId: string,
  paths: string[],
  token: string | undefined,
  body: unknown,
  status: number,
): Promise<void> {
  const before = room.audit.all().length;
  const results = [];
  for (const path of paths) results.push(await send(room.baseUrl, "PUT", path, token, body));
  expect(results[0]?.status).toBe(status);
  expect(results[1]).toEqual(results[0]);
  const added = room.audit.all().slice(before);
  expect(added).toHaveLength(status === 403 ? 2 : 0);
  if (status === 403) expect(auditFact(added[0])).toEqual(auditFact(added[1]));
  expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
}

async function putSharing(
  baseUrl: string,
  path: string,
  body: unknown,
  auth: { token?: string; cookie?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = `commona_session=${auth.cookie}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

async function ownersInRoom(room: Awaited<ReturnType<typeof startRoom>>): Promise<{
  roomId: string;
  ownerOne: string;
  ownerTwo: string;
  a1: string;
}> {
  const ownerOne = room.tokens.issueOwnerToken("O1");
  const ownerTwo = room.tokens.issueOwnerToken("O2");
  const created = await send(room.baseUrl, "POST", "/rooms", ownerOne, {});
  const roomId = (created.body as { room: { id: string } }).room.id;
  const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerOne, { agentId: "A1" });
  await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerTwo, { agentId: "A2" });
  return { roomId, ownerOne, ownerTwo, a1: (first.body as { token: string }).token };
}
