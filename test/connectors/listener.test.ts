import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WAKE_EVENT_TYPE, WAKE_HEADER_EVENT, WAKE_HEADER_ROOM_ID, WAKE_HEADER_WAKE_ID, type WakeEvent } from "../../contract/index.js";
import { commandHandoff, combineHandoffs, spoolHandoff } from "../../src/listener/handoff.js";
import { startWakeListener } from "../../src/listener/server.js";
import { readFile } from "node:fs/promises";

const event: WakeEvent = {
  type: WAKE_EVENT_TYPE,
  wakeId: "wake_listener_1",
  roomId: "room_listener_1",
  occurredAt: "2026-10-15T00:00:00.000Z",
  round: 1,
  author: { agentId: "A1", ownerId: "O1" },
  recipient: { agentId: "A2", ownerId: "O2" },
  disclosure: "content",
  activity: { itemKind: "message" },
  content: {
    kind: "message",
    itemId: "post_listener_1",
    text: "Hello from the first synthetic agent.",
    replyToId: null,
    round: 1,
  },
};

describe("wake listener", () => {
  it("writes a matching webhook into the recipient spool", async () => {
    const spool = mkdtempSync(path.join(tmpdir(), "commona-spool-"));
    const listener = await startWakeListener({ handoff: spoolHandoff(spool) });
    try {
      const response = await postWake(listener.url, event);
      expect(response.status).toBe(204);
      const stored = JSON.parse(await readFile(path.join(spool, "A2", "wake_listener_1.json"), "utf8")) as WakeEvent;
      expect(stored.content && "text" in stored.content ? stored.content.text : "").toBe("Hello from the first synthetic agent.");
    } finally {
      await listener.close();
    }
  });

  it("refuses a wake whose header does not match the body", async () => {
    const spool = mkdtempSync(path.join(tmpdir(), "commona-spool-"));
    let delivered = 0;
    const listener = await startWakeListener({
      handoff: {
        async deliver() {
          delivered += 1;
        },
      },
    });
    try {
      const response = await postWake(listener.url, event, { wakeId: "wake_other" });
      expect(response.status).toBe(400);
      expect(delivered).toBe(0);
      await expect(readFile(path.join(spool, "A2", "wake_listener_1.json"), "utf8")).rejects.toThrow();
    } finally {
      await listener.close();
    }
  });

  it("hands the wake JSON to a local command", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "commona-cmd-")), "wake.json");
    const script = "let d='';process.stdin.on('data',(c)=>{d+=c});process.stdin.on('end',()=>{require('node:fs').writeFileSync(process.argv[1], d)})";
    const listener = await startWakeListener({
      handoff: commandHandoff(process.execPath, ["-e", script, out]),
    });
    try {
      const response = await postWake(listener.url, event);
      expect(response.status).toBe(204);
      const stored = JSON.parse(await readFile(out, "utf8")) as WakeEvent;
      expect(stored.wakeId).toBe(event.wakeId);
    } finally {
      await listener.close();
    }
  });

  it("keeps a successful spool write when the command fails", async () => {
    const spool = mkdtempSync(path.join(tmpdir(), "commona-both-"));
    const handoff = combineHandoffs(spoolHandoff(spool), commandHandoff(process.execPath, ["-e", "process.exit(2)"]), () => undefined);
    const listener = await startWakeListener({ handoff });
    try {
      const response = await postWake(listener.url, event);
      expect(response.status).toBe(204);
      const stored = JSON.parse(await readFile(path.join(spool, "A2", `${event.wakeId}.json`), "utf8")) as WakeEvent;
      expect(stored.recipient.agentId).toBe("A2");
    } finally {
      await listener.close();
    }
  });
});

function postWake(baseUrl: string, body: WakeEvent, headers: { wakeId?: string } = {}): Promise<Response> {
  return fetch(`${baseUrl}/wake`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WAKE_HEADER_EVENT]: WAKE_EVENT_TYPE,
      [WAKE_HEADER_WAKE_ID]: headers.wakeId ?? body.wakeId,
      [WAKE_HEADER_ROOM_ID]: body.roomId,
    },
    body: JSON.stringify(body),
  });
}
