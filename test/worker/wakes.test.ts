import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
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
      instance.setWakeDue(wakeId, Date.now());
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
    const pending = await waitForWakes(room.roomId, (found) => found[0]?.attempts === 1);
    const wakeId = pending[0]?.id ?? "";

    await releaseWake(wakeId);
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    await waitForWakes(room.roomId, (found) => found[0]?.attempts === 2);
    await releaseWake(wakeId);
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    await waitForWakes(room.roomId, (found) => found[0]?.attempts === 3);
    await releaseWake(wakeId);
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

  it("leaves a later retry queued when an earlier room alarm fires", async () => {
    const later = await openRoom();
    const earlier = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(later.hostAgentId, webhookUrl);
      instance.saveAgentWebhook(earlier.hostAgentId, webhookUrl);
      instance.recordWakeFetches(500);
    });
    await postNote(later.roomId, later.guestKey, note);
    await postNote(earlier.roomId, earlier.guestKey, note);
    const laterPending = await waitForWakes(
      later.roomId,
      (found) => found.length === 1 && found[0]?.state === "pending" && found[0]?.attempts === 1,
    );
    const earlierPending = await waitForWakes(
      earlier.roomId,
      (found) => found.length === 1 && found[0]?.state === "pending" && found[0]?.attempts === 1,
    );
    const laterId = laterPending[0]?.id ?? "";
    const earlierId = earlierPending[0]?.id ?? "";
    const now = Date.now();
    const earlierDue = now + 5_000;
    const laterDue = now + 60_000;
    await runInDurableObject(directory(), (instance) => {
      instance.setWakeDue(earlierId, earlierDue);
      instance.setWakeDue(laterId, laterDue);
      instance.postponeOtherWakes([earlierId, laterId], now + 120_000);
    });

    await deleteRoom(earlier.roomId, earlier.hostKey);

    const scheduled = await runInDurableObject(directory(), (instance) => instance.scheduledAlarm());
    const queued = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
    expect(scheduled).not.toBeNull();
    expect(scheduled ?? 0).toBeLessThan(laterDue);
    expect(queued[0]).toEqual({ wakeId: laterId, dueMs: laterDue });
    expect(queued.some((row) => row.wakeId === earlierId)).toBe(false);
    const before = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(before.filter((hit) => hit.body.includes(later.roomId))).toHaveLength(1);

    expect(await runDurableObjectAlarm(directory())).toBe(true);

    const rows = await runInDurableObject(directory(), (instance) => instance.wakeRows());
    expect(rows.filter((row) => row.roomId === later.roomId)).toEqual([
      expect.objectContaining({ id: laterId, state: "pending", attempts: 1 }),
    ]);
    const after = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(after.filter((hit) => hit.body.includes(later.roomId))).toHaveLength(1);
    const still = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
    expect(still.find((row) => row.wakeId === laterId)).toEqual({ wakeId: laterId, dueMs: laterDue });
    const armed = await runInDurableObject(directory(), (instance) => instance.scheduledAlarm());
    expect(armed).toBe(laterDue);

    await runInDurableObject(directory(), (instance) => {
      instance.setRecordedWakeStatus(200);
      instance.setWakeDue(laterId, Date.now());
    });
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    const done = await waitForWakes(later.roomId, (found) => found[0]?.state === "webhook_succeeded");
    expect(done).toEqual([expect.objectContaining({ id: laterId, state: "webhook_succeeded", attempts: 2 })]);
  });

  it("retries the first send after a reset once the recovery deadline passes", async () => {
    // The webhook call records the recovery row, then stops. No attempt is
    // stored and deferRetry does not run. Eviction drops the in-memory service.
    const room = await openRoom();
    await runInDurableObject(directory(), (instance) => {
      instance.saveAgentWebhook(room.hostAgentId, webhookUrl);
      instance.recordWakeFetches(200);
      instance.resetNextWakeSend();
    });

    let evicted = false;
    try {
      await postNote(room.roomId, room.guestKey, note);
      const started = await waitForResetSend(room.roomId);
      const wakeId = started.wakeId;
      const dueMs = started.dueMs;
      const remaining = dueMs - Date.now();
      expect(remaining).toBeGreaterThan(1_000);
      expect(remaining).toBeLessThanOrEqual(WAKE_RETRY_DELAYS_MS[0] + 500);
      expect(started.attempts).toBe(0);
      expect(started.state).toBe("pending");

      await evictDurableObject(directory());
      evicted = true;

      const stored = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
      expect(stored.find((row) => row.wakeId === wakeId)).toEqual({ wakeId, dueMs });
      const parked = await runInDurableObject(directory(), (instance) => instance.wakeRows());
      expect(parked.filter((row) => row.roomId === room.roomId)).toEqual([
        expect.objectContaining({ id: wakeId, state: "pending", attempts: 0 }),
      ]);

      await runInDurableObject(directory(), (instance) => {
        instance.recordWakeFetches(200);
        instance.postponeOtherWakes([wakeId], Date.now() + 120_000);
      });
      expect(await runDurableObjectAlarm(directory())).toBe(true);
      const early = await runInDurableObject(directory(), (instance) => instance.wakeRows());
      expect(early.filter((row) => row.roomId === room.roomId)).toEqual([
        expect.objectContaining({ id: wakeId, state: "pending", attempts: 0 }),
      ]);
      expect(await runInDurableObject(directory(), (instance) => instance.wakeFetches())).toEqual([]);
      expect(await runInDurableObject(directory(), (instance) => instance.scheduledAlarm())).toBe(dueMs);

      await runInDurableObject(directory(), (instance) => {
        instance.setWakeDue(wakeId, Date.now());
      });
      expect(await runDurableObjectAlarm(directory())).toBe(true);
      const done = await waitForWakes(room.roomId, (found) => found[0]?.state === "webhook_succeeded");
      expect(done).toEqual([expect.objectContaining({ id: wakeId, state: "webhook_succeeded", attempts: 1 })]);
      const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
      expect(fetches).toHaveLength(1);
      expect(JSON.parse(fetches[0]?.body ?? "")).toMatchObject({
        wakeId,
        roomId: room.roomId,
        content: { kind: "message", text: note },
      });
      const after = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
      expect(after.filter((row) => row.wakeId === wakeId)).toEqual([]);
      expect(JSON.stringify(fetches)).not.toContain(room.guestKey);
      expect(JSON.stringify(fetches)).not.toContain(room.hostKey);
      expect(JSON.stringify(fetches)).not.toContain(hostSecret);
    } finally {
      if (!evicted) await evictDurableObject(directory()).catch(() => undefined);
    }
  });

  it("keeps the scheduling row while the webhook request is in flight", async () => {
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
    const wakeId = pending[0]?.id ?? "";
    await runInDurableObject(directory(), (instance) => {
      instance.recordWakeFetches(200);
    });
    await releaseWake(wakeId);

    expect(await runDurableObjectAlarm(directory())).toBe(true);

    const during = await runInDurableObject(directory(), (instance) => instance.alarmsDuringFetchFor(wakeId));
    const held = during.find((row) => row.wakeId === wakeId);
    expect(held).toBeDefined();
    expect(held?.dueMs ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(Date.now());
    const done = await waitForWakes(room.roomId, (found) => found[0]?.state === "webhook_succeeded");
    expect(done).toEqual([expect.objectContaining({ id: wakeId, state: "webhook_succeeded", attempts: 2 })]);
    const after = await runInDurableObject(directory(), (instance) => instance.wakeAlarmRows());
    expect(after.filter((row) => row.wakeId === wakeId)).toEqual([]);
    const fetches = await runInDurableObject(directory(), (instance) => instance.wakeFetches());
    expect(fetches).toHaveLength(1);
    expect(JSON.stringify(fetches)).not.toContain(room.guestKey);
    expect(JSON.stringify(fetches)).not.toContain(room.hostKey);
  });
});

function directory(): { fetch(request: Request): Promise<Response> } {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
}

async function releaseWake(wakeId: string): Promise<void> {
  await runInDurableObject(directory(), (instance) => {
    instance.setWakeDue(wakeId, Date.now());
  });
}

async function deleteRoom(roomId: string, hostKey: string): Promise<void> {
  const deleted = await SELF.fetch(`https://room.example.test/rooms/${roomId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hostKey}` },
  });
  const text = await deleted.text();
  expect(deleted.status).toBe(200);
  expect(text).not.toContain(hostSecret);
  expect(text.includes(hostKey)).toBe(false);
}

async function openRoom(): Promise<{
  roomId: string;
  hostAgentId: string;
  hostKey: string;
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
  const created = JSON.parse(body) as {
    invites?: string[];
    roomId?: string;
    agentId?: string;
    credential?: string;
  };
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
    hostKey: created.credential ?? "",
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

async function waitForResetSend(
  roomId: string,
): Promise<{ wakeId: string; dueMs: number; state: string; attempts: number }> {
  let last: { wakeId: string; dueMs: number; state: string; attempts: number } | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await runInDurableObject(directory(), (instance) => instance.wakeRows());
    const wake = rows.find((row) => row.roomId === roomId);
    if (wake) {
      const during = await runInDurableObject(directory(), (instance) => instance.alarmsDuringFetchFor(wake.id));
      const held = during.find((row) => row.wakeId === wake.id);
      if (held) {
        last = { wakeId: wake.id, dueMs: held.dueMs, state: wake.state, attempts: wake.attempts };
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last ?? { wakeId: "", dueMs: 0, state: "", attempts: -1 };
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
