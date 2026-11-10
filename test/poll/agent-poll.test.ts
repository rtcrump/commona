import { describe, expect, it } from "vitest";
import { hashToken, systemClock } from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/log.js";
import { createTokenStore } from "../../src/auth/store.js";
import { openDatabase } from "../../src/db.js";
import { guard } from "../../src/guard/index.js";
import { createOwnerNotifier } from "../../src/notices/store.js";
import { feedRoomId, reserveAgentPoll } from "../../src/poll/agent-poll.js";
import type { RoomDeps } from "../../src/room/deps.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

const agentToken = "agent-key-for-poll";
const ownerToken = "owner-key-for-poll";
const roomId = "room_11111111-1111-4111-8111-111111111111";

function deps(): RoomDeps {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO owners (id, email, display_name, role, token_hash) VALUES (?, ?, ?, ?, ?)").run(
    "O1",
    "o1@example.test",
    "Owner One",
    "participant",
    hashToken(ownerToken),
  );
  db.prepare("INSERT INTO agents (id, owner_id, display_name, email, token_hash) VALUES (?, ?, ?, ?, ?)").run(
    "A1",
    "O1",
    "Agent One",
    "a1@example.test",
    hashToken(agentToken),
  );
  db.prepare("INSERT INTO rooms (id, created_at, created_by_owner_id) VALUES (?, ?, ?)").run(
    roomId,
    "2026-04-01T12:00:00.000Z",
    "O1",
  );
  const clock = systemClock;
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

describe("agent poll guard", () => {
  it("decodes the routed room segment once, preserving encoded percent signs", () => {
    expect(feedRoomId(`/rooms/${roomId}/feed`)).toBe(roomId);
    expect(feedRoomId(`/rooms/${roomId.replace("room_", "%72%6f%6Fm%5f")}/feed`)).toBe(roomId);
    expect(feedRoomId("/%72ooms/room_%252f/%66eed")).toBe("room_%2f");
    expect(feedRoomId("/health")).toBeNull();
  });

  it("allows an agent key once per 30 seconds and does not limit an owner", async () => {
    const room = deps();
    const first = reserveAgentPoll(room, `Bearer ${agentToken}`, 1_000, roomId);
    expect(first).toBeNull();
    const second = reserveAgentPoll(room, `Bearer ${agentToken}`, 1_000 + 29_000, roomId);
    expect(second?.status).toBe(429);
    expect(second?.headers.get("retry-after")).toBe("30");
    expect(await second?.json()).toEqual({ error: { code: "validation", message: "Try again later." } });
    const later = reserveAgentPoll(room, `Bearer ${agentToken}`, 1_000 + 30_000, roomId);
    expect(later).toBeNull();
    expect(reserveAgentPoll(room, `Bearer ${ownerToken}`, 2_000, roomId)).toBeNull();
    expect(reserveAgentPoll(room, `Bearer ${ownerToken}`, 2_001, roomId)).toBeNull();
    expect(reserveAgentPoll(room, "Bearer missing-token", 2_001, roomId)).toBeNull();
    const stored = room.db.prepare("SELECT token_hash FROM agent_polls").all() as { token_hash: string }[];
    expect(stored.map((row) => row.token_hash)).toEqual([hashToken(agentToken)]);
    expect(JSON.stringify(stored)).not.toContain(agentToken);
    room.db.close();
  });

  it("does not reserve a poll after the room row is gone", async () => {
    const room = deps();
    expect(reserveAgentPoll(room, `Bearer ${agentToken}`, 1_000, roomId)).toBeNull();
    const before = room.db.prepare("SELECT last_ms FROM agent_polls").get() as { last_ms: number };
    room.db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    const again = reserveAgentPoll(room, `Bearer ${agentToken}`, 1_000 + 1_000, roomId);
    expect(again?.status).toBe(404);
    const after = room.db.prepare("SELECT last_ms FROM agent_polls").get() as { last_ms: number };
    expect(after.last_ms).toBe(before.last_ms);
    room.db.close();
  });
});
