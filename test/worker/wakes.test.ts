import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_SIGNATURE,
  WAKE_HEADER_TIMESTAMP,
  WAKE_HEADER_WAKE_ID,
  WAKE_RETRY_DELAYS_MS,
  wakeContentNotice,
  wakeEmailSubject,
} from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";
const webhookUrl = "https://hooks.example.test/wake";
const note = "Bring napkins";
const fileText = "The checklist is complete.";

describe("worker wakes", () => {
  afterEach(async () => {
    await runInDurableObject(directory(), (instance) => {
      instance.clearWakeTestHooks();
    });
  });

  it("delivers a signed content wake for an accepted post", async () => {
    const room = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(room.hostAgentId, webhookUrl);
      instance.recordWakeFetches(200);
    });
    await postNote(room.roomId, room.guestKey, note);

    const rows = await waitForWakes(room.roomId, (found) => found.some((row) => row.state === "webhook_succeeded"));
    expect(rows).toEqual([
      expect.objectContaining({
        recipientAgentId: room.hostAgentId,
        authorAgentId: room.guestAgentId,
        itemKind: "message",
        state: "webhook_succeeded",
        attempts: 1,
      }),
    ]);
    const wakeId = rows[0]?.id ?? "";
    const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(fetches).toHaveLength(1);
    const hit = fetches[0];
    expect(hit?.method).toBe("POST");
    expect(hit?.url).toBe(webhookUrl);
    expect(JSON.parse(hit?.body ?? "")).toMatchObject({
      type: WAKE_EVENT_TYPE,
      wakeId,
      roomId: room.roomId,
      disclosure: "content",
      content: { kind: "message", text: note },
    });
    expect(hit?.headers[WAKE_HEADER_EVENT.toLowerCase()]).toBe(WAKE_EVENT_TYPE);
    expect(hit?.headers[WAKE_HEADER_WAKE_ID.toLowerCase()]).toBe(wakeId);
    expect(hit?.headers[WAKE_HEADER_ROOM_ID.toLowerCase()]).toBe(room.roomId);
    const signed = await runInDurableObject(directory(), (instance) =>
      instance.wakeSignatureMatches(
        room.hostAgentId,
        hit?.headers[WAKE_HEADER_TIMESTAMP.toLowerCase()] ?? "",
        hit?.body ?? "",
        hit?.headers[WAKE_HEADER_SIGNATURE.toLowerCase()] ?? "",
      ),
    );
    expect(signed).toBe(true);
    const alarms = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
    expect(alarms.filter((row) => row.wakeId === wakeId)).toEqual([]);
    expect(JSON.stringify(fetches)).not.toContain(room.guestKey);
    expect(JSON.stringify(fetches)).not.toContain(hostSecret);
  });

  it("delivers a wake for an accepted file and leaves the file text out", async () => {
    const room = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(room.hostAgentId, webhookUrl);
      instance.recordWakeFetches(200);
    });
    const uploaded = await SELF.fetch(`https://room.example.test/rooms/${room.roomId}/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${room.guestKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "notes.txt",
        mediaType: "text/plain",
        contentBase64: btoa(fileText),
        metadata: { topic: "questions" },
      }),
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.text()).not.toContain(hostSecret);

    const rows = await waitForWakes(room.roomId, (found) => found.some((row) => row.state === "webhook_succeeded"));
    expect(rows).toEqual([
      expect.objectContaining({
        recipientAgentId: room.hostAgentId,
        authorAgentId: room.guestAgentId,
        itemKind: "file",
        state: "webhook_succeeded",
        attempts: 1,
      }),
    ]);
    const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.body).not.toContain(fileText);
    expect(fetches[0]?.body).not.toContain("notes.txt");
    expect(JSON.parse(fetches[0]?.body ?? "")).toMatchObject({
      type: WAKE_EVENT_TYPE,
      disclosure: "activity_only",
      roomId: room.roomId,
    });
  });

  it("retries a refused webhook when the durable object alarm runs", async () => {
    const room = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(room.hostAgentId, webhookUrl);
      instance.recordWakeFetches(500);
    });
    await postNote(room.roomId, room.guestKey, note);

    const pending = await waitForWakes(
      room.roomId,
      (found) => found.length === 1 && found[0]?.state === "pending" && found[0]?.attempts === 1,
    );
    expect(pending).toHaveLength(1);
    const wakeId = pending[0]?.id ?? "";
    const alarms = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
    const alarm = alarms.find((row) => row.wakeId === wakeId);
    const remaining = (alarm?.dueMs ?? 0) - Date.now();
    expect(alarm?.wakeId).toBe(wakeId);
    expect(remaining).toBeGreaterThan(1_500);
    expect(remaining).toBeLessThan(WAKE_RETRY_DELAYS_MS[0] + 500);
    const scheduled = await runInDurableObject(directory(), (instance) => instance.scheduledAlarm());
    expect(scheduled).not.toBeNull();
    expect(scheduled ?? 0).toBeLessThanOrEqual(alarm?.dueMs ?? 0);

    await runInDurableObject(directory(), (instance) => {
      instance.setRecordedWakeStatus(200);
    });
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    const done = await waitForWakes(room.roomId, (found) => found.some((row) => row.state === "webhook_succeeded"));
    expect(done).toEqual([
      expect.objectContaining({ id: wakeId, state: "webhook_succeeded", attempts: 2 }),
    ]);
    const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(fetches).toHaveLength(2);
    expect(fetches.every((hit) => JSON.parse(hit.body).content.text === note)).toBe(true);
  });

  it("sends fallback mail after the alarm exhausts webhook attempts", async () => {
    const room = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(room.hostAgentId, webhookUrl);
      instance.recordWakeFetches(500);
      instance.captureWakeMail();
    });
    await postNote(room.roomId, room.guestKey, note);
    await waitForWakes(room.roomId, (found) => found[0]?.attempts === 1);

    expect(await runDurableObjectAlarm(directory())).toBe(true);
    await waitForWakes(room.roomId, (found) => found[0]?.attempts === 2);
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    await waitForWakes(room.roomId, (found) => found[0]?.attempts === 3);
    expect(await runDurableObjectAlarm(directory())).toBe(true);

    const rows = await waitForWakes(room.roomId, (found) => found[0]?.state === "email_sent");
    expect(rows).toEqual([
      expect.objectContaining({
        recipientAgentId: room.hostAgentId,
        itemKind: "message",
        state: "email_sent",
        attempts: 4,
      }),
    ]);
    const mail = await runInDurableObject(directory(), (instance) => instance.wakeMail());
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe(`${room.hostAgentId}@example.test`);
    expect(mail[0]?.text).toBe(wakeContentNotice(room.roomId, "message"));
    expect(mail[0]?.text).not.toContain(note);
    expect(mail[0]?.subject).toBe(
      wakeEmailSubject({ disclosure: "content", roomId: room.roomId, content: { kind: "message", itemId: "post_1", text: note, replyToId: null, round: 1 } }),
    );
    const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(fetches).toHaveLength(4);
    const audit = await runInDurableObject(directory(), (instance) => instance.auditSnapshot());
    const roomAudit = audit.filter((row) => row.room === room.roomId);
    expect(roomAudit.filter((row) => row.action === "wake_retry" && row.result === "retried")).toHaveLength(3);
    expect(roomAudit.filter((row) => row.action === "wake_fallback_email" && row.result === "fell_back")).toHaveLength(1);
    expect(JSON.stringify(mail)).not.toContain(room.guestKey);
  });
});

function directory(): { fetch(request: Request): Promise<Response> } {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
}

async function openRoom(): Promise<{
  roomId: string;
  hostAgentId: string;
  guestAgentId: string;
  guestKey: string;
}> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({ title: "Sunday lunch", hostName: "Host (demo)", inviteCount: 1 }),
  });
  const body = await response.text();
  expect(response.status).toBe(201);
  expect(body.includes(hostSecret)).toBe(false);
  const created = JSON.parse(body) as { invites?: string[]; roomId?: string; agentId?: string };
  const link = created.invites?.[0] ?? "";
  const secret = new URL(link).pathname.split("/")[3] ?? "";
  const roomId = created.roomId ?? "";
  const opened = await SELF.fetch(`https://room.example.test/api/r/${roomId}?t=${encodeURIComponent(secret)}`);
  const openedText = await opened.text();
  expect(opened.status).toBe(200);
  expect(openedText.includes(secret)).toBe(false);
  expect(openedText.includes(hostSecret)).toBe(false);
  const joined = JSON.parse(openedText) as { agentId: string; agentKey: string };
  return {
    roomId,
    hostAgentId: created.agentId ?? "",
    guestAgentId: joined.agentId,
    guestKey: joined.agentKey,
  };
}

async function postNote(roomId: string, agentKey: string, text: string): Promise<void> {
  const posted = await SELF.fetch(`https://room.example.test/api/r/${roomId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  expect(posted.status).toBe(201);
  const postedText = await posted.text();
  expect(postedText).toContain(text);
  expect(postedText.includes(hostSecret)).toBe(false);
  expect(postedText.includes(agentKey)).toBe(false);
}

interface WakeRow {
  id: string;
  roomId: string;
  state: string;
  attempts: number;
}

async function waitForWakes(roomId: string, ready: (rows: WakeRow[]) => boolean): Promise<WakeRow[]> {
  let last: WakeRow[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await runInDurableObject(directory(), (instance) => instance.wakeRows());
    last = rows.filter((row) => row.roomId === roomId);
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}
