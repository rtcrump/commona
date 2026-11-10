import { describe, expect, it } from "vitest";
import {
  WAKE_EVENT_TYPE,
  WAKE_SIGNATURE_TOLERANCE_MS,
  WAKE_WEBHOOK_URL_ERROR,
  WakeWebhookUrlError,
  hashToken,
  signWakeBody,
  verifyWakeSignature,
  wakeContentNotice,
  wakeTimestamp,
  type WakeEvent,
} from "../../contract/index.js";
import { openDatabase } from "../../src/db.js";
import type { WakeLog } from "../../src/wakeup/log.js";
import { registerAgentWebhook } from "../../src/wakeup/register.js";
import { revealWebhookSigningSecret } from "../../src/wakeup/secret.js";
import { postWakeWebhook } from "../../src/wakeup/webhook.js";
import { send, startRoom } from "../room/server.js";
import {
  MESSAGE_TEXT,
  ROOM_ID,
  WHEN,
  enqueueInput,
  expectChain,
  insertMessage,
  setSharing,
  setupRoom,
  stopRoom,
  useService,
} from "./room.js";

const SECRET = "whsec_do_not_log_8f3a";
const NOW_MS = Date.parse("2026-01-02T03:04:05.000Z");

const event: WakeEvent = {
  type: WAKE_EVENT_TYPE,
  wakeId: "wake_1",
  roomId: "room_1",
  occurredAt: "2026-01-02T03:04:05.006Z",
  round: 1,
  author: { agentId: "A1", ownerId: "O1" },
  recipient: { agentId: "A2", ownerId: "O2" },
  disclosure: "activity_only",
  activity: {},
};

function agentDb() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO owners (id, email, display_name, role) VALUES ('O1', 'o1@example.test', 'Owner One', 'participant')",
  ).run();
  db.prepare(
    "INSERT INTO owners (id, email, display_name, role) VALUES ('O2', 'o2@example.test', 'Owner Two', 'participant')",
  ).run();
  db.prepare(
    "INSERT INTO agents (id, owner_id, display_name, email) VALUES ('A1', 'O1', 'Agent One', 'a1@example.test')",
  ).run();
  return db;
}

function header(headers: NodeJS.Dict<string | string[] | undefined>, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

describe("wake webhook https and signatures", () => {
  it("refuses plain http at registration unless the dev flag allows loopback", () => {
    const db = agentDb();
    try {
      expect(() => registerAgentWebhook(db, "A1", "http://example.com/wake")).toThrow(WAKE_WEBHOOK_URL_ERROR);
      expect(() => registerAgentWebhook(db, "A1", "http://127.0.0.1/wake")).toThrow(WakeWebhookUrlError);
      expect(() => registerAgentWebhook(db, "A1", "http://localhost/wake")).toThrow(WakeWebhookUrlError);
      expect(() => registerAgentWebhook(db, "A1", "http://127.0.0.1.example/wake", { allowInsecureLocalhost: true })).toThrow(
        WakeWebhookUrlError,
      );
      expect(() => registerAgentWebhook(db, "A1", "http://0.0.0.0/wake", { allowInsecureLocalhost: true })).toThrow(
        WakeWebhookUrlError,
      );
      expect(db.prepare("SELECT webhook_url FROM agents WHERE id = 'A1'").get()).toEqual({ webhook_url: null });

      registerAgentWebhook(db, "A1", "http://127.0.0.1:9/wake", { allowInsecureLocalhost: true });
      expect(db.prepare("SELECT webhook_url FROM agents WHERE id = 'A1'").get()).toEqual({
        webhook_url: "http://127.0.0.1:9/wake",
      });
      registerAgentWebhook(db, "A1", "http://localhost:9/wake", { allowInsecureLocalhost: true });
      registerAgentWebhook(db, "A1", "https://hooks.example.test/wake");
      expect(db.prepare("SELECT webhook_url FROM agents WHERE id = 'A1'").get()).toEqual({
        webhook_url: "https://hooks.example.test/wake",
      });
    } finally {
      db.close();
    }
  });

  it("refuses plain http at send time and posts when the dev flag allows loopback", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(
      postWakeWebhook({ url: "http://example.com/wake", event, secret: "secret", timestamp: "1", fetchImpl }),
    ).rejects.toThrow(WAKE_WEBHOOK_URL_ERROR);
    await expect(
      postWakeWebhook({ url: "http://127.0.0.1/wake", event, secret: "secret", timestamp: "1", fetchImpl }),
    ).rejects.toThrow(WakeWebhookUrlError);
    expect(calls).toBe(0);

    await postWakeWebhook({
      url: "http://127.0.0.1/wake",
      event,
      secret: "secret",
      timestamp: "1",
      fetchImpl,
      allowInsecureLocalhost: true,
    });
    await postWakeWebhook({
      url: "http://localhost/wake",
      event,
      secret: "secret",
      timestamp: "1",
      fetchImpl,
      allowInsecureLocalhost: true,
    });
    await postWakeWebhook({
      url: "https://hooks.example.test/wake",
      event,
      secret: "secret",
      timestamp: "1",
      fetchImpl,
    });
    expect(calls).toBe(3);
  });

  it("verifies a signature and rejects a tampered body, a wrong secret, or a stale timestamp", () => {
    const body = JSON.stringify(event);
    const timestamp = wakeTimestamp(NOW_MS);
    const signature = signWakeBody(SECRET, timestamp, body);
    const valid = { secret: SECRET, timestamp, rawBody: body, signature, nowMs: NOW_MS };
    expect(verifyWakeSignature(valid)).toBe(true);

    expect(verifyWakeSignature({ ...valid, rawBody: `${body} ` })).toBe(false);
    expect(verifyWakeSignature({ ...valid, secret: "other-secret" })).toBe(false);
    expect(verifyWakeSignature({ ...valid, signature: "v1=ab" })).toBe(false);

    const staleSeconds = Math.floor(NOW_MS / 1000) - WAKE_SIGNATURE_TOLERANCE_MS / 1000 - 1;
    const stale = String(staleSeconds);
    expect(
      verifyWakeSignature({
        ...valid,
        timestamp: stale,
        signature: signWakeBody(SECRET, stale, body),
      }),
    ).toBe(false);

    const future = String(Math.floor(NOW_MS / 1000) + WAKE_SIGNATURE_TOLERANCE_MS / 1000 + 1);
    expect(
      verifyWakeSignature({
        ...valid,
        timestamp: future,
        signature: signWakeBody(SECRET, future, body),
      }),
    ).toBe(false);

    const edge = String(Math.floor(NOW_MS / 1000) - WAKE_SIGNATURE_TOLERANCE_MS / 1000);
    expect(
      verifyWakeSignature({
        ...valid,
        timestamp: edge,
        signature: signWakeBody(SECRET, edge, body),
      }),
    ).toBe(true);
  });

  it("signs the delivered body and keeps the secret out of the webhook", async () => {
    const room = await setupRoom();
    try {
      room.db.prepare("UPDATE agents SET webhook_signing_secret = ? WHERE id = 'A2'").run(SECRET);
      insertMessage(room.db);
      const sent = room.service.enqueue(enqueueInput())[0];
      await room.service.deliver(sent?.wakeId ?? "");
      const hit = room.webhook.hits[0];
      expect(hit).toBeDefined();
      const timestamp = header(hit!.headers, "x-commona-timestamp");
      const signature = header(hit!.headers, "x-commona-signature");
      expect(timestamp).toBe(wakeTimestamp(Date.parse(WHEN)));
      expect(
        verifyWakeSignature({
          secret: SECRET,
          timestamp,
          rawBody: hit!.raw,
          signature,
          nowMs: Date.parse(WHEN),
        }),
      ).toBe(true);
      expect(
        verifyWakeSignature({
          secret: SECRET,
          timestamp,
          rawBody: `${hit!.raw}x`,
          signature,
          nowMs: Date.parse(WHEN),
        }),
      ).toBe(false);
      expect(hit!.raw).not.toContain(SECRET);
      expect(JSON.stringify(hit!.headers)).not.toContain(SECRET);
    } finally {
      await stopRoom(room);
    }
  });

  it("keeps the signing secret out of logs, audit rows, and responses", async () => {
    const lines: string[] = [];
    const log: WakeLog = {
      info(message) {
        lines.push(message);
      },
      error(message) {
        lines.push(message);
      },
    };
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const original = new Map(methods.map((name) => [name, console[name].bind(console)]));
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      };
    }

    const room = await setupRoom();
    const api = await startRoom();
    try {
      const stored = room.db.prepare("SELECT webhook_signing_secret AS secret FROM agents WHERE id = 'A2'").get() as {
        secret: string;
      };
      const secret = stored.secret;
      expect(secret).not.toBe(hashToken(secret));
      insertMessage(room.db, { text: MESSAGE_TEXT });
      setSharing(room.db, "O1", "O2", "messages");
      room.webhook.setStatus(500);
      const service = useService(room, { log });
      const sent = service.enqueue(enqueueInput())[0];
      await service.deliver(sent?.wakeId ?? "");

      expect(lines.some((line) => line.startsWith("wake webhook failed"))).toBe(true);
      expect(lines.some((line) => line.startsWith("wake email sent"))).toBe(true);
      const audit = JSON.stringify(expectChain(room.db));
      const mail = room.mail.messages.map((message) => `${message.raw}\n${message.body}`).join("\n");
      const hooks = room.webhook.hits.map((hit) => `${hit.raw}\n${JSON.stringify(hit.headers)}`).join("\n");
      for (const dump of [lines.join("\n"), audit, mail, hooks]) {
        expect(dump).not.toContain(secret);
      }
      expect(mail).not.toContain(MESSAGE_TEXT);
      expect(mail).toContain(wakeContentNotice(ROOM_ID, "message"));

      const apiSecret = (
        api.db.prepare("SELECT webhook_signing_secret AS secret FROM agents WHERE id = 'A1'").get() as { secret: string }
      ).secret;
      const owner = api.tokens.issueOwnerToken("O1");
      const created = await send(api.baseUrl, "POST", "/rooms", owner, {});
      const roomId = (created.body as { room: { id: string } }).room.id;
      const joined = await send(api.baseUrl, "POST", `/rooms/${roomId}/members`, owner, { agentId: "A1" });
      const again = await send(api.baseUrl, "POST", `/rooms/${roomId}/members`, owner, { agentId: "A1" });
      const responses = JSON.stringify([created.body, joined.body, again.body, api.audit.all()]);
      expect(responses).not.toContain(apiSecret);
      expect(joined.body).not.toHaveProperty("webhookSigningSecret");
    } finally {
      for (const [name, method] of original) console[name] = method as (typeof console)[typeof name];
      await stopRoom(room);
      await api.stop();
    }
  });

  it("stores the raw secret and reveals it once", () => {
    const db = agentDb();
    try {
      const first = revealWebhookSigningSecret(db, "agent", "A1");
      const owner = revealWebhookSigningSecret(db, "owner", "O1");
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(owner).toMatch(/^[0-9a-f]{64}$/);
      expect(revealWebhookSigningSecret(db, "agent", "A1")).toBeNull();
      expect(revealWebhookSigningSecret(db, "owner", "O1")).toBeNull();
      const row = db.prepare("SELECT webhook_signing_secret AS secret FROM agents WHERE id = 'A1'").get() as {
        secret: string;
      };
      expect(row.secret).toBe(first);
      expect(row.secret).not.toBe(hashToken(first ?? ""));
    } finally {
      db.close();
    }
  });

  it("does not post when the dev flag is off, including to loopback", async () => {
    const room = await setupRoom();
    try {
      insertMessage(room.db);
      let calls = 0;
      const lines: string[] = [];
      const service = useService(room, {
        allowInsecureLocalhost: false,
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        log: {
          info(message) {
            lines.push(message);
          },
          error(message) {
            lines.push(message);
          },
        },
      });
      const sent = service.enqueue(enqueueInput())[0];
      await service.deliver(sent?.wakeId ?? "");
      expect(calls).toBe(0);
      expect(room.webhook.hits).toEqual([]);
      expect(lines.join("\n")).toContain(WAKE_WEBHOOK_URL_ERROR);
    } finally {
      await stopRoom(room);
    }
  });
});
