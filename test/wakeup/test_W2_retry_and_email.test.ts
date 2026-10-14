import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  ReasonCode,
  WAKE_ATTEMPT_LIMIT,
  WAKE_EMAIL_FROM,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_WAKE_ID,
  WAKE_RETRY_DELAYS_MS,
  WAKE_WEBHOOK_TIMEOUT_MS,
  WakeState,
  activityOnlyText,
  wakeEmailSubject,
  wakeFailedNoticeMessage,
} from "../../contract/index.js";
import { wakeEmailText } from "../../src/wakeup/index.js";
import {
  MESSAGE_TEXT,
  ROOM_ID,
  clearWebhook,
  enqueueInput,
  expectChain,
  insertFile,
  insertMessage,
  setSharing,
  setupRoom,
  startRedirectServer,
  startResetServer,
  startSlowServer,
  stopRoom,
  useService,
} from "./room.js";

describe("W2 retry and email fallback", () => {
  it("retries a failed webhook after 2 seconds and stops on the first 2xx", async () => {
    const room = await setupRoom();
    try {
      insertMessage(room.db);
      room.webhook.setStatus(500);
      const service = useService(room, {
        sleep: async (ms) => {
          room.sleeps.push(ms);
          room.webhook.setStatus(201);
        },
      });
      const event = service.enqueue(enqueueInput())[0];
      const result = await service.deliver(event?.wakeId ?? "");
      expect(result).toMatchObject({ state: WakeState.WebhookSucceeded, attempts: 2 });
      expect(room.sleeps).toEqual([WAKE_RETRY_DELAYS_MS[0]]);
      expect(room.webhook.hits).toHaveLength(2);
      expect(room.mail.messages).toEqual([]);
      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.action, row.result, row.detail.attempt, row.detail.reasonCode, row.detail.httpStatus])).toEqual([
        [AuditAction.WakeRetry, AuditResult.Retried, 1, ReasonCode.WebhookHttp, 500],
        [AuditAction.Wake, AuditResult.Ok, 2, undefined, undefined],
      ]);
      expect(audit[0]?.agentId).toBe("A2");
      expect(audit[0]?.detail.authorAgentId).toBe("A1");
    } finally {
      await stopRoom(room);
    }
  });

  it("tries four webhooks at 2s, 8s, and 20s, then sends the activity-only email", async () => {
    const room = await setupRoom();
    try {
      insertMessage(room.db);
      room.webhook.setStatus(503);
      const event = room.service.enqueue(enqueueInput())[0];
      const result = await room.service.deliver(event?.wakeId ?? "");
      expect(WAKE_ATTEMPT_LIMIT).toBe(4);
      expect(result).toMatchObject({ state: WakeState.EmailSent, attempts: 4 });
      expect(room.sleeps).toEqual([...WAKE_RETRY_DELAYS_MS]);
      expect(room.webhook.hits).toHaveLength(4);
      expect(room.webhook.hits.every((hit) => hit.method === "POST" && hit.json && typeof hit.json === "object")).toBe(
        true,
      );
      for (const hit of room.webhook.hits) {
        expect(hit.headers[WAKE_HEADER_EVENT.toLowerCase()]).toBe(WAKE_EVENT_TYPE);
        expect(hit.headers[WAKE_HEADER_WAKE_ID.toLowerCase()]).toBe(event?.wakeId);
        expect(hit.headers[WAKE_HEADER_ROOM_ID.toLowerCase()]).toBe(ROOM_ID);
        expect(hit.raw).not.toContain(MESSAGE_TEXT);
      }
      expect(room.mail.messages).toHaveLength(1);
      const mail = room.mail.messages[0];
      expect(mail?.from).toBe(WAKE_EMAIL_FROM);
      expect(mail?.to).toEqual(["a2@example.test"]);
      expect(mail?.headers.Subject).toBe(wakeEmailSubject(event!));
      expect(mail?.headers[WAKE_HEADER_EVENT]).toBe(WAKE_EVENT_TYPE);
      expect(mail?.headers[WAKE_HEADER_WAKE_ID]).toBe(event?.wakeId);
      expect(mail?.headers[WAKE_HEADER_ROOM_ID]).toBe(ROOM_ID);
      expect(mail?.body).toBe(activityOnlyText(ROOM_ID));
      expect(mail?.body).toBe(wakeEmailText(event!));
      expect(mail?.body).not.toContain(MESSAGE_TEXT);

      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.action, row.result])).toEqual([
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeFallbackEmail, AuditResult.FellBack],
      ]);
      expect(audit.slice(0, 3).map((row) => row.detail.attempt)).toEqual([1, 2, 3]);
      expect(audit[3]?.detail).toMatchObject({
        attempt: 4,
        reasonCode: ReasonCode.WebhookHttp,
        httpStatus: 503,
        authorAgentId: "A1",
      });
      expect(room.db.prepare("SELECT COUNT(*) AS n FROM notices").get()).toEqual({ n: 0 });
    } finally {
      await stopRoom(room);
    }
  });

  it("skips webhook attempts when the agent has no webhook and emails the content", async () => {
    const room = await setupRoom();
    try {
      const text = ".\nPlease file this under questions.";
      insertMessage(room.db, { text });
      setSharing(room.db, "O1", "O2", "messages");
      clearWebhook(room.db, "A2");
      room.db.prepare("UPDATE agents SET event_target = ? WHERE id = 'A2'").run(room.webhook.url);
      const event = room.service.enqueue(enqueueInput())[0];
      const result = await room.service.deliver(event?.wakeId ?? "");
      expect(result).toMatchObject({ state: WakeState.EmailSent, attempts: 0 });
      expect(room.webhook.hits).toEqual([]);
      expect(room.sleeps).toEqual([]);
      expect(room.mail.messages).toHaveLength(1);
      expect(room.mail.messages[0]?.from).toBe(WAKE_EMAIL_FROM);
      expect(room.mail.messages[0]?.headers.Subject).toBe(`Commona: new message in room ${ROOM_ID}`);
      expect(room.mail.messages[0]?.body).toBe(text);
      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.action, row.result])).toEqual([
        [AuditAction.WakeFallbackEmail, AuditResult.FellBack],
      ]);
      expect(audit[0]?.detail.attempt).toBeUndefined();
      expect(audit[0]?.detail.reasonCode).toBeUndefined();
    } finally {
      await stopRoom(room);
    }
  });

  it("emails a file description when webhook attempts are exhausted", async () => {
    const room = await setupRoom();
    try {
      const text = "The checklist is complete.";
      insertFile(room.db, { bytes: Buffer.from(text), mediaType: "text/plain" });
      setSharing(room.db, "O1", "O2", "messages_files");
      room.webhook.setStatus(500);
      const event = room.service.enqueue(enqueueInput({ itemKind: "file", itemId: "file_1" }))[0];
      await room.service.deliver(event?.wakeId ?? "");
      expect(room.mail.messages[0]?.headers.Subject).toBe(`Commona: new file in room ${ROOM_ID}`);
      expect(room.mail.messages[0]?.body).toBe(wakeEmailText(event!));
      expect(room.mail.messages[0]?.body).toContain("notes.txt");
      expect(room.mail.messages[0]?.body).toContain(text);
    } finally {
      await stopRoom(room);
    }
  });

  it("records wake_failed and notifies the recipient owner when email also fails", async () => {
    const room = await setupRoom();
    const reset = await startResetServer();
    try {
      insertMessage(room.db);
      room.webhook.setStatus(500);
      const service = useService(room, { smtp: { host: reset.host, port: reset.port } });
      const event = service.enqueue(enqueueInput())[0];
      const result = await service.deliver(event?.wakeId ?? "");
      expect(result).toMatchObject({ state: WakeState.Failed, attempts: 4 });
      expect(room.webhook.hits).toHaveLength(4);
      expect(room.mail.messages).toEqual([]);
      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.action, row.result])).toEqual([
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeRetry, AuditResult.Retried],
        [AuditAction.WakeFailed, AuditResult.Failed],
      ]);
      expect(audit[3]?.detail.reasonCode).toBe(ReasonCode.EmailFailed);
      expect(audit[3]?.ownerId).toBe("O2");
      const notice = room.db
        .prepare("SELECT owner_id, room_id, kind, message, item_id FROM notices")
        .get() as { owner_id: string; room_id: string; kind: string; message: string; item_id: string };
      expect(notice).toEqual({
        owner_id: "O2",
        room_id: ROOM_ID,
        kind: "wake_failed",
        message: wakeFailedNoticeMessage(ROOM_ID),
        item_id: "post_1",
      });
    } finally {
      await reset.stop();
      await stopRoom(room);
    }
  });

  it("does not retry when email is the only channel and it fails", async () => {
    const room = await setupRoom();
    const reset = await startResetServer();
    try {
      insertMessage(room.db);
      clearWebhook(room.db, "A2");
      const service = useService(room, { smtp: { host: reset.host, port: reset.port } });
      const event = service.enqueue(enqueueInput())[0];
      const result = await service.deliver(event?.wakeId ?? "");
      expect(result).toMatchObject({ state: WakeState.Failed, attempts: 0 });
      expect(room.webhook.hits).toEqual([]);
      expect(room.sleeps).toEqual([]);
      const audit = expectChain(room.db);
      expect(audit.map((row) => [row.action, row.result, row.detail.reasonCode])).toEqual([
        [AuditAction.WakeFailed, AuditResult.Failed, ReasonCode.EmailFailed],
      ]);
      expect(room.db.prepare("SELECT COUNT(*) AS n FROM notices").get()).toEqual({ n: 1 });
    } finally {
      await reset.stop();
      await stopRoom(room);
    }
  });

  it("does not follow a webhook redirect", async () => {
    const room = await setupRoom();
    const redirect = await startRedirectServer(room.webhook.url);
    try {
      insertMessage(room.db);
      room.db.prepare("UPDATE agents SET webhook_url = ? WHERE id = 'A2'").run(redirect.url);
      const event = room.service.enqueue(enqueueInput())[0];
      await room.service.deliver(event?.wakeId ?? "");
      expect(redirect.hits).toBe(4);
      expect(room.webhook.hits).toEqual([]);
      expect(room.mail.messages).toHaveLength(1);
      const fallback = expectChain(room.db).at(-1);
      expect(fallback?.action).toBe(AuditAction.WakeFallbackEmail);
      expect(fallback?.detail.httpStatus).toBe(302);
      expect(fallback?.detail.reasonCode).toBe(ReasonCode.WebhookHttp);
    } finally {
      await redirect.stop();
      await stopRoom(room);
    }
  });

  it("classifies a slow webhook as a timeout instead of its late status", async () => {
    const room = await setupRoom();
    const slow = await startSlowServer(400, 500);
    try {
      insertMessage(room.db);
      room.db.prepare("UPDATE agents SET webhook_url = ? WHERE id = 'A2'").run(slow.url);
      const service = useService(room, { timeoutMs: 40 });
      const event = service.enqueue(enqueueInput())[0];
      const started = Date.now();
      await service.deliver(event?.wakeId ?? "");
      expect(Date.now() - started).toBeLessThan(1_000);
      const audit = expectChain(room.db);
      expect(audit.slice(0, 3).every((row) => row.detail.reasonCode === ReasonCode.WebhookTimeout)).toBe(true);
      expect(audit.slice(0, 3).every((row) => row.detail.httpStatus === undefined)).toBe(true);
      expect(audit[3]?.detail.reasonCode).toBe(ReasonCode.WebhookTimeout);
      expect(room.mail.messages).toHaveLength(1);
    } finally {
      await slow.stop();
      await stopRoom(room);
    }
  });

  it("aborts the first webhook at the 5 second contract timeout", async () => {
    const room = await setupRoom();
    try {
      expect(WAKE_WEBHOOK_TIMEOUT_MS).toBe(5_000);
      insertMessage(room.db);
      let calls = 0;
      let elapsed = 0;
      const fetchImpl: typeof fetch = (_url, init) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(new Response(null, { status: 204 }));
        const started = Date.now();
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              elapsed = Date.now() - started;
              reject(new DOMException("The operation was aborted", "AbortError"));
            },
            { once: true },
          );
        });
      };
      const service = useService(room, { fetchImpl });
      const event = service.enqueue(enqueueInput())[0];
      const result = await service.deliver(event?.wakeId ?? "");
      expect(result.state).toBe(WakeState.WebhookSucceeded);
      expect(calls).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(12_000);
      expect(room.sleeps).toEqual([WAKE_RETRY_DELAYS_MS[0]]);
      expect(expectChain(room.db)[0]?.detail.reasonCode).toBe(ReasonCode.WebhookTimeout);
    } finally {
      await stopRoom(room);
    }
  }, 20_000);

  it("treats a reset webhook connection as a network error and then falls back", async () => {
    const room = await setupRoom();
    const reset = await startResetServer();
    try {
      insertMessage(room.db);
      room.db.prepare("UPDATE agents SET webhook_url = ? WHERE id = 'A2'").run(`http://127.0.0.1:${reset.port}/wake`);
      const event = room.service.enqueue(enqueueInput())[0];
      const result = await room.service.deliver(event?.wakeId ?? "");
      expect(result.state).toBe(WakeState.EmailSent);
      expect(room.sleeps).toEqual([...WAKE_RETRY_DELAYS_MS]);
      const audit = expectChain(room.db);
      expect(audit[0]?.detail.reasonCode).toBe(ReasonCode.WebhookNetwork);
      expect(audit[3]?.action).toBe(AuditAction.WakeFallbackEmail);
      expect(room.mail.messages).toHaveLength(1);
    } finally {
      await reset.stop();
      await stopRoom(room);
    }
  });
});
