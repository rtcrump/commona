import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { AgentPostLimited, reserveAgentPost } from "../../src/agent-api/limit.js";
import { ensureAgentApiSchema } from "../../src/agent-api/schema.js";
import { createAuditLog } from "../../src/audit/log.js";
import { createTokenStore } from "../../src/auth/store.js";
import { openDatabase } from "../../src/db.js";
import { guard } from "../../src/guard/index.js";
import { createOwnerNotifier } from "../../src/notices/store.js";
import type { RoomDeps } from "../../src/room/deps.js";
import { RoomHttpError } from "../../src/room/http.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

const roomId = "room_22222222-2222-4222-8222-222222222222";

function deps(): RoomDeps {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO owners (id, email, display_name, role, token_hash) VALUES (?, ?, ?, ?, ?)").run(
    "O1",
    "o1@example.test",
    "Owner One",
    "participant",
    hashToken("owner-key"),
  );
  db.prepare("INSERT INTO agents (id, owner_id, display_name, email, token_hash) VALUES (?, ?, ?, ?, ?)").run(
    "A1",
    "O1",
    "Agent One",
    "a1@example.test",
    hashToken("agent-key"),
  );
  db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, ?)").run(
    roomId,
    "2026-04-01T12:00:00.000Z",
    "O1",
  );
  ensureAgentApiSchema(db);
  const now = Date.parse("2026-04-01T12:00:00.000Z");
  const insert = db.prepare("INSERT INTO agent_post_hits (agent_id, room_id, posted_ms) VALUES (?, ?, ?)");
  for (let index = 0; index < 30; index += 1) insert.run("A1", roomId, now);
  const clock = { now: () => new Date(now) };
  return {
    db,
    clock,
    tokens: createTokenStore(db),
    audit: createAuditLog(db, clock),
    sharing: createSharingDirectory(db),
    guard,
    notices: createOwnerNotifier(db, clock),
  };
}

describe("post limit on a deleted room", () => {
  it("returns 404 and does not write another hit when the room row is gone", () => {
    const room = deps();
    room.db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    let caught: unknown;
    try {
      reserveAgentPost(room, { kind: "agent", ownerId: "O1", agentId: "A1" }, roomId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RoomHttpError);
    expect((caught as RoomHttpError).status).toBe(404);
    const hits = room.db.prepare("SELECT COUNT(*) AS n FROM agent_post_hits").get() as { n: number };
    expect(hits.n).toBe(30);
    room.db.close();
  });

  it("does not carry a full hour in one room over to another room", () => {
    const room = deps();
    const other = "room_33333333-3333-4333-8333-333333333333";
    room.db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, ?)").run(
      other,
      "2026-04-01T12:00:00.000Z",
      "O1",
    );
    const principal = { kind: "agent" as const, ownerId: "O1", agentId: "A1" };
    expect(() => reserveAgentPost(room, principal, roomId)).toThrow(AgentPostLimited);
    expect(() => reserveAgentPost(room, principal, other)).not.toThrow();
    const hits = room.db.prepare("SELECT COUNT(*) AS n FROM agent_post_hits WHERE room_id = ?").get(other) as {
      n: number;
    };
    expect(hits.n).toBe(1);
    room.db.close();
  });
});
