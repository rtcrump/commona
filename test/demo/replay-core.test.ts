import { describe, expect, it } from "vitest";
import { AuditAction } from "../../contract/index.js";
import { guard } from "../../src/guard/index.js";
import {
  DEMO_MESSAGES,
  VISIBILITY_CHECKPOINTS,
  type DemoMessageId,
  type DemoPerson,
} from "../../src/demo/transcript.js";
import { send, startRoom } from "../room/server.js";

const PEOPLE = {
  nia: { ownerId: "O1", agentId: "A1" },
  sol: { ownerId: "O2", agentId: "A2" },
} as const;

const AUTHORS: Record<DemoMessageId, DemoPerson> = {
  larkOffer: "nia",
  reedOffer: "sol",
  agreement: "nia",
  reportToNia: "nia",
  reportToSol: "sol",
};

describe("public demo replay matches the room", () => {
  it("hides each note until that owner approves, then finishes one task and both reports", async () => {
    const room = await startRoom({ guard });
    try {
      const ownerNia = room.tokens.issueOwnerToken(PEOPLE.nia.ownerId);
      const ownerSol = room.tokens.issueOwnerToken(PEOPLE.sol.ownerId);
      const created = await send(room.baseUrl, "POST", "/rooms", ownerNia, {});
      expect(created.status).toBe(201);
      const roomId = (created.body as { room: { id: string } }).room.id;
      const first = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerNia, {
        agentId: PEOPLE.nia.agentId,
      });
      const second = await send(room.baseUrl, "POST", `/rooms/${roomId}/members`, ownerSol, {
        agentId: PEOPLE.sol.agentId,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const niaAgent = (first.body as { token: string }).token;
      const solAgent = (second.body as { token: string }).token;
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("none");
      expect(room.sharing.level(roomId, "O2", "O1")).toBe("none");

      const agentTokens = { nia: niaAgent, sol: solAgent };
      const ownerTokens = { nia: ownerNia, sol: ownerSol };
      let posted = 0;
      let approved = 0;
      for (const checkpoint of VISIBILITY_CHECKPOINTS) {
        while (posted < checkpoint.posted.length) {
          const id = checkpoint.posted[posted];
          if (!id) throw new Error("missing posted message");
          const author = AUTHORS[id];
          const response = await send(room.baseUrl, "POST", `/rooms/${roomId}/posts`, agentTokens[author], {
            text: DEMO_MESSAGES[id],
          });
          expect(response.status, id).toBe(201);
          expect(response.body).toMatchObject({ outcome: "accepted" });
          posted += 1;
        }
        while (approved < checkpoint.approvals.length) {
          const person = checkpoint.approvals[approved];
          if (!person) throw new Error("missing approval");
          const other: DemoPerson = person === "nia" ? "sol" : "nia";
          const response = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, ownerTokens[person], {
            fromOwnerId: PEOPLE[person].ownerId,
            toOwnerId: PEOPLE[other].ownerId,
            level: "messages",
          });
          expect(response.status, person).toBe(200);
          approved += 1;
        }
        expect(feedTexts(await send(room.baseUrl, "GET", `/rooms/${roomId}/feed`, niaAgent))).toEqual(
          checkpoint.niaSees.map((id) => DEMO_MESSAGES[id]),
        );
        expect(feedTexts(await send(room.baseUrl, "GET", `/rooms/${roomId}/feed`, solAgent))).toEqual(
          checkpoint.solSees.map((id) => DEMO_MESSAGES[id]),
        );
      }

      const refused = await send(room.baseUrl, "PUT", `/rooms/${roomId}/sharing`, niaAgent, {
        fromOwnerId: "O1",
        toOwnerId: "O2",
        level: "messages_files",
      });
      expect(refused.status).toBe(403);
      expect(room.sharing.level(roomId, "O1", "O2")).toBe("messages");
      expect(room.sharing.level(roomId, "O2", "O1")).toBe("messages");
      const approvals = room.audit
        .all()
        .filter((entry) => entry.action === AuditAction.SettingChange && entry.detail.level === "messages");
      expect(approvals.map((entry) => entry.detail.fromOwnerId)).toEqual(["O1", "O2"]);
    } finally {
      await room.stop();
    }
  });
});

function feedTexts(response: { status: number; body: unknown }): string[] {
  expect(response.status).toBe(200);
  const items = (response.body as { items?: { kind?: string; text?: string }[] }).items ?? [];
  return items.filter((item) => item.kind === "message").map((item) => item.text ?? "");
}
