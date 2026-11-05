import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
  allowInsecureLocalWebhook,
  ContractError,
  systemClock,
  verifyWakeSignature,
  WAKE_HEADER_WAKE_ID,
  WAKE_RETRY_DELAYS_MS,
  WakeState,
  type WakeEmail,
} from "../../contract/index.js";
import { createAuditLog } from "../audit/log.js";
import { createTokenStore } from "../auth/store.js";
import { createSqliteDatabase } from "../db/adapter.js";
import { DurableSqlDriver, type DurableSqlStorage } from "../db/durable.js";
import { prepareDatabase } from "../db/prepare.js";
import type { CommonaEnv } from "../env.js";
import { guard } from "../guard/index.js";
import { auditHostRefusal, isHostRefusal, useHostSecret } from "../host/host-room.js";
import { createHttpApp } from "../http/server.js";
import type { CommonaHono } from "../http/types.js";
import { createOwnerNotifier } from "../notices/store.js";
import { feedRoomId, reserveAgentPoll } from "../poll/agent-poll.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { createSharingDirectory } from "../sharing/index.js";
import { registerAgentWebhook } from "../wakeup/register.js";
import { signingSecretFor } from "../wakeup/secret.js";
import { createWakeService, type WakeService } from "../wakeup/service.js";
import { sendSmtp, smtpFromEnv, type SmtpEndpoint } from "../wakeup/smtp.js";
import { registerWorkerMailTransport } from "../wakeup/smtp-worker.js";
import { WakeSendStopped } from "../wakeup/webhook.js";

interface DurableRoomStorage extends DurableSqlStorage {
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/**
 * One SQLite Durable Object for the whole server.
 * Rooms, keys, invites, and the audit chain stay in one database, which is
 * what the Node server did. The free plan only offers this SQLite kind.
 */
interface WakeFetchRecord {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

export class DirectoryObject extends DurableObject<CommonaEnv> {
  private deps!: RoomDeps;
  private app!: CommonaHono;
  private wake!: WakeService;
  private smtpEndpoint?: SmtpEndpoint;
  private fetchOverride?: typeof fetch;
  private mailOverride?: (email: WakeEmail) => Promise<void>;
  private recordedFetches: WakeFetchRecord[] = [];
  private recordedStatus = 200;
  private capturedMail: WakeEmail[] = [];
  /** Alarm rows observed while a webhook request was in flight, keyed by wake id. */
  private alarmsDuringFetch = new Map<string, { wakeId: string; dueMs: number }[]>();
  /** Test hook. The next webhook call records the deadline, then the send stops. */
  private resetNextSend = false;

  constructor(ctx: DurableObjectState, env: CommonaEnv) {
    super(ctx, env);
    this.boot();
  }

  /**
   * Open SQLite, then build the same HTTP app as Node, including wake delivery.
   * One webhook attempt runs in this request. A retry waits on the object alarm,
   * because the free plan cannot spend the 2s, 8s, and 20s gaps inside the request.
   */
  private boot(): void {
    const db = createSqliteDatabase(new DurableSqlDriver(this.storage()));
    try {
      db.pragma("foreign_keys = ON");
    } catch {
      // The Durable Object opens with foreign keys available.
    }
    prepareDatabase(db);
    const clock = systemClock;
    const audit = createAuditLog(db, clock);
    const notices = createOwnerNotifier(db, clock);
    const env = this.workerProcessEnv();
    this.smtpEndpoint = smtpFromEnv(env);
    registerWorkerMailTransport();
    const wake = createWakeService({
      db,
      clock,
      audit,
      notices,
      allowInsecureLocalhost: allowInsecureLocalWebhook(env),
      fetchImpl: (input, init) => this.fetchWake(input, init),
      sendMail: (email) => this.dispatchMail(email),
      deferRetry: (wakeId, delayMs) => this.deferWake(wakeId, delayMs),
      ...(this.smtpEndpoint ? { smtp: this.smtpEndpoint } : {}),
    });
    this.wake = wake;
    const deps: RoomDeps = {
      db,
      clock,
      tokens: createTokenStore(db),
      audit,
      sharing: createSharingDirectory(db),
      guard,
      notices,
      wakeQueue: wake,
      deliverWake: (wakeId) => this.deliverWake(wakeId),
      ...(this.smtpEndpoint ? { smtp: this.smtpEndpoint } : {}),
      clearAlarmIfEmpty: () => this.clearAlarmIfEmpty(),
    };
    this.deps = deps;
    this.app = createHttpApp(deps);
  }

  /**
   * Keep the background delivery alive after the HTTP response is returned.
   * A recovery deadline is stored before the send. A reset while the webhook
   * or mail call is in flight leaves that row, and the alarm retries it once
   * the deadline passes. The row is removed when delivery reaches a terminal
   * state. A failed attempt replaces it with the next retry.
   */
  private deliverWake(wakeId: string): Promise<void> {
    const pending = this.deliverWakeOnce(wakeId);
    this.ctx.waitUntil(pending);
    return pending;
  }

  private async deliverWakeOnce(wakeId: string): Promise<void> {
    await this.persistRecoveryDeadline(wakeId);
    try {
      const result = await this.wake.deliver(wakeId);
      if (result.state !== WakeState.Pending) await this.finishRecoveryDeadline(wakeId);
    } catch (error) {
      if (error instanceof ContractError && error.message === "wake not found") {
        await this.finishRecoveryDeadline(wakeId);
      }
    }
  }

  /**
   * The first retry delay. Insert ignores a row that is already scheduled so
   * a later retry keeps its own deadline. The alarm is armed before the send.
   */
  private async persistRecoveryDeadline(wakeId: string): Promise<void> {
    const due = Date.now() + WAKE_RETRY_DELAYS_MS[0];
    this.deps.db
      .prepare(
        `INSERT INTO wake_alarms (wake_id, due_ms) VALUES (?, ?)
         ON CONFLICT(wake_id) DO NOTHING`,
      )
      .run(wakeId, due);
    await this.armWakeAlarm();
  }

  /**
   * Drop a finished wake's recovery row. Clear or move the platform alarm
   * only when it was this row's deadline, so an earlier alarm set for
   * another reason stays.
   */
  private async finishRecoveryDeadline(wakeId: string): Promise<void> {
    const row = this.deps.db.prepare("SELECT due_ms AS dueMs FROM wake_alarms WHERE wake_id = ?").get(wakeId) as
      | { dueMs: number }
      | undefined;
    this.deleteWakeAlarm(wakeId);
    const next = this.deps.db.prepare("SELECT MIN(due_ms) AS due FROM wake_alarms").get() as
      | { due: number | null }
      | undefined;
    const existing = await this.storage().getAlarm();
    if (next?.due != null) {
      if (existing === next.due) return;
      if (existing === null || (row !== undefined && existing === row.dueMs)) await this.storage().setAlarm(next.due);
      return;
    }
    if (row !== undefined && existing === row.dueMs) await this.storage().deleteAlarm();
  }

  private fetchWake(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
    if (!this.resetNextSend) return (this.fetchOverride ?? fetch)(input, init);
    this.resetNextSend = false;
    const request = new Request(input, init);
    const wakeId = request.headers.get(WAKE_HEADER_WAKE_ID);
    if (wakeId) this.alarmsDuringFetch.set(wakeId, this.wakeAlarmRows());
    throw new WakeSendStopped();
  }

  private async dispatchMail(email: WakeEmail): Promise<void> {
    if (this.mailOverride) {
      await this.mailOverride(email);
      return;
    }
    if (!this.smtpEndpoint) throw new Error("smtp is not configured");
    await sendSmtp(this.smtpEndpoint, email);
  }

  /** Bindings only. Process env is not copied in, so a local shell cannot widen webhook http. */
  private workerProcessEnv(): NodeJS.ProcessEnv {
    const env = this.env;
    return {
      ...(typeof env.COMMONA_SMTP_HOST === "string" ? { COMMONA_SMTP_HOST: env.COMMONA_SMTP_HOST } : {}),
      ...(typeof env.COMMONA_SMTP_PORT === "string" ? { COMMONA_SMTP_PORT: env.COMMONA_SMTP_PORT } : {}),
      ...(typeof env.COMMONA_ALLOW_INSECURE_WEBHOOKS === "string"
        ? { COMMONA_ALLOW_INSECURE_WEBHOOKS: env.COMMONA_ALLOW_INSECURE_WEBHOOKS }
        : {}),
    };
  }

  /**
   * The alarm belongs to the whole object. Clear it only when no rooms remain,
   * and hold other requests so a new room cannot set one in between.
   */
  private async clearAlarmIfEmpty(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.dropOrphanWakeAlarms();
      const row = this.deps.db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number } | undefined;
      if (Number(row?.n ?? 0) !== 0) {
        const pending = this.deps.db.prepare("SELECT COUNT(*) AS n FROM wake_alarms").get() as { n: number } | undefined;
        if (Number(pending?.n ?? 0) === 0) return;
        await this.armWakeAlarm();
        return;
      }
      this.deps.db.prepare("DELETE FROM wake_alarms").run();
      await this.storage().deleteAlarm();
    });
  }

  /**
   * The platform calls this when the alarm is due. A test may run it sooner.
   * Only a wake whose due_ms has arrived is delivered. An alarm left behind
   * after a room delete does not skip another room's backoff.
   * Webhook retries live here so one request does not sleep for 2s, 8s, and 20s.
   */
  async alarm(): Promise<void> {
    await this.deliverScheduledWakes(Date.now());
    await this.armWakeAlarm(true);
  }

  private async deferWake(wakeId: string, delayMs: number): Promise<void> {
    const due = Date.now() + delayMs;
    this.deps.db
      .prepare(
        `INSERT INTO wake_alarms (wake_id, due_ms) VALUES (?, ?)
         ON CONFLICT(wake_id) DO UPDATE SET due_ms = excluded.due_ms`,
      )
      .run(wakeId, due);
    await this.armWakeAlarm();
  }

  /**
   * Deliver wakes whose deadline has arrived. The scheduling row stays until
   * that delivery reaches a terminal state. A restart while the webhook or
   * mail call is still running can retry the same row. A retry replaces the
   * row with the next deadline before it returns.
   */
  private async deliverScheduledWakes(nowMs: number): Promise<void> {
    this.dropOrphanWakeAlarms();
    const ids = this.wakeIdsDue(nowMs);
    for (const wakeId of ids) {
      try {
        const result = await this.wake.deliver(wakeId);
        if (result.state !== WakeState.Pending) this.deleteWakeAlarm(wakeId);
      } catch (error) {
        if (error instanceof ContractError && error.message === "wake not found") {
          this.deleteWakeAlarm(wakeId);
          continue;
        }
        const due = Date.now() + WAKE_RETRY_DELAYS_MS[0];
        this.deps.db
          .prepare(
            `INSERT INTO wake_alarms (wake_id, due_ms) VALUES (?, ?)
             ON CONFLICT(wake_id) DO UPDATE SET due_ms = excluded.due_ms`,
          )
          .run(wakeId, due);
        throw error;
      }
    }
  }

  private deleteWakeAlarm(wakeId: string): void {
    this.deps.db.prepare("DELETE FROM wake_alarms WHERE wake_id = ?").run(wakeId);
  }

  private dropOrphanWakeAlarms(): void {
    this.deps.db.prepare("DELETE FROM wake_alarms WHERE wake_id NOT IN (SELECT id FROM wakes)").run();
  }

  private wakeIdsDue(nowMs: number): string[] {
    const rows = this.deps.db
      .prepare("SELECT wake_id AS wakeId FROM wake_alarms WHERE due_ms <= ? ORDER BY due_ms, wake_id")
      .all(nowMs) as { wakeId: string }[];
    return rows.map((row) => row.wakeId);
  }

  /**
   * Keep the earliest wake retry. An earlier alarm set for another reason stays.
   * After the handler itself runs, that fired alarm is spent, so the next real
   * deadline is armed even when the stored alarm time is earlier.
   */
  private async armWakeAlarm(afterFire = false): Promise<void> {
    const row = this.deps.db.prepare("SELECT MIN(due_ms) AS due FROM wake_alarms").get() as
      | { due: number | null }
      | undefined;
    if (row?.due == null) return;
    const existing = await this.storage().getAlarm();
    if (existing === row.due) return;
    if (!afterFire && existing !== null && existing <= row.due) return;
    await this.storage().setAlarm(row.due);
  }

  private storage(): DurableRoomStorage {
    return this.ctx.storage as DurableRoomStorage;
  }

  async fetch(request: Request): Promise<Response> {
    if (isHostRefusal(request)) {
      auditHostRefusal(this.deps);
      return Response.json(RoomHttpError.forbidden().body(), {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    const url = new URL(request.url);
    if (request.method === "GET") {
      let roomId: string | null;
      try {
        roomId = feedRoomId(url.pathname);
      } catch {
        return Response.json(RoomHttpError.badRequest().body(), {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      if (roomId !== null) {
        const limited = reserveAgentPoll(this.deps, request.headers.get("authorization") ?? undefined, Date.now(), roomId);
        if (limited) return limited;
      }
    }
    applyPublicBindings(this.env);
    return useHostSecret(this.env.COMMONA_HOST_SECRET, () => Promise.resolve(this.app.fetch(request)));
  }

  /**
   * Invite row a test can read inside the object.
   * The raw secret is not a column. secretHash is SHA-256 hex.
   */
  inviteRecord(id: string): {
    secretHash: string;
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
  } | null {
    const row = this.deps.db
      .prepare("SELECT secret_hash, expires_at, used_at, revoked_at FROM invites WHERE id = ?")
      .get(id) as
      | { secret_hash: string; expires_at: string; used_at: string | null; revoked_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      secretHash: row.secret_hash,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
    };
  }

  /**
   * First name saved on the join page, for a test.
   * secretHash is SHA-256 hex. The raw invite secret is not stored.
   */
  pendingName(inviteId: string): { firstName: string; secretHash: string } | null {
    const row = this.deps.db
      .prepare("SELECT first_name, secret_hash FROM invite_pending_names WHERE invite_id = ?")
      .get(inviteId) as { first_name: string; secret_hash: string } | undefined;
    if (!row) return null;
    return { firstName: row.first_name, secretHash: row.secret_hash };
  }

  /** Display names stored on owners, for a test. */
  ownerDisplayNames(): string[] {
    const rows = this.deps.db.prepare("SELECT display_name FROM owners ORDER BY display_name").all() as {
      display_name: string;
    }[];
    return rows.map((row) => row.display_name);
  }

  /**
   * Agent key storage a test can read inside the object.
   * tokenHash and revokedHash are SHA-256 hex. The raw key is not stored.
   */
  agentKeyState(agentId: string): { tokenHash: string | null; revokedHash: string | null } | null {
    const agent = this.deps.db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agentId) as
      | { token_hash: string | null }
      | undefined;
    if (!agent) return null;
    const revoked = this.deps.db
      .prepare("SELECT token_hash FROM agent_key_revocations WHERE agent_id = ?")
      .get(agentId) as { token_hash: string } | undefined;
    return { tokenHash: agent.token_hash, revokedHash: revoked?.token_hash ?? null };
  }

  /**
   * Owner key storage a test can read inside the object.
   * tokenHash is SHA-256 hex. The raw token is not stored.
   */
  ownerKeyState(ownerId: string): { tokenHash: string | null } | null {
    const owner = this.deps.db.prepare("SELECT token_hash FROM owners WHERE id = ?").get(ownerId) as
      | { token_hash: string | null }
      | undefined;
    if (!owner) return null;
    return { tokenHash: owner.token_hash };
  }

  /** How many posts this agent has counted toward the hourly limit. */
  postHitCount(agentId: string): number {
    const row = this.deps.db.prepare("SELECT COUNT(*) AS n FROM agent_post_hits WHERE agent_id = ?").get(agentId) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /** Rows a test can read inside the object. Tokens are not columns here. */
  auditSnapshot(): {
    action: string;
    result: string;
    ownerId: string;
    agentId: string;
    room: string;
    detailJson: string;
  }[] {
    const rows = this.deps.db
      .prepare(
        "SELECT action, result, owner_id, agent_id, room, detail_json FROM audit_log ORDER BY seq ASC",
      )
      .all() as {
      action: string;
      result: string;
      owner_id: string;
      agent_id: string;
      room: string;
      detail_json: string;
    }[];
    return rows.map((row) => ({
      action: row.action,
      result: row.result,
      ownerId: row.owner_id,
      agentId: row.agent_id,
      room: row.room,
      detailJson: row.detail_json,
    }));
  }

  /** Save a webhook for a test. The signing secret stays in the object. */
  saveAgentWebhook(agentId: string, url: string): void {
    registerAgentWebhook(this.deps.db, agentId, url, {
      allowInsecureLocalhost: allowInsecureLocalWebhook(this.workerProcessEnv()),
    });
  }

  /** Wake rows a test can read. The signing secret is not a column here. */
  wakeRows(): {
    id: string;
    roomId: string;
    recipientAgentId: string;
    authorAgentId: string;
    itemKind: string;
    state: string;
    attempts: number;
  }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, room_id AS roomId, recipient_agent_id AS recipientAgentId,
                author_agent_id AS authorAgentId, item_kind AS itemKind, state, attempts
         FROM wakes ORDER BY created_at, recipient_agent_id, id`,
      )
      .all() as {
      id: string;
      roomId: string;
      recipientAgentId: string;
      authorAgentId: string;
      itemKind: string;
      state: string;
      attempts: number;
    }[];
    return rows;
  }

  /** Scheduled webhook retries. `dueMs` is the wall-clock time the alarm is waiting for. */
  wakeAlarmRows(): { wakeId: string; dueMs: number }[] {
    return this.deps.db
      .prepare("SELECT wake_id AS wakeId, due_ms AS dueMs FROM wake_alarms ORDER BY due_ms, wake_id")
      .all() as { wakeId: string; dueMs: number }[];
  }

  scheduledAlarm(): Promise<number | null> {
    return this.storage().getAlarm();
  }

  /**
   * Test hook. Moves one scheduled retry to `dueMs`.
   * Production alarm delivery does not call this. Tests use it so they do not
   * wait out the 2s, 8s, and 20s backoff, and so two rooms can sit at known deadlines.
   */
  setWakeDue(wakeId: string, dueMs: number): void {
    const result = this.deps.db.prepare("UPDATE wake_alarms SET due_ms = ? WHERE wake_id = ?").run(dueMs, wakeId);
    if (result.changes !== 1) throw new Error("wake alarm is not scheduled");
  }

  /**
   * Test hook. Pushes every scheduled wake except `keep` out to `dueMs`.
   * A test can then be the earliest remaining retry without delivering another room.
   */
  postponeOtherWakes(keep: readonly string[], dueMs: number): void {
    const held = new Set(keep);
    for (const row of this.wakeAlarmRows()) {
      if (held.has(row.wakeId)) continue;
      this.deps.db.prepare("UPDATE wake_alarms SET due_ms = ? WHERE wake_id = ?").run(dueMs, row.wakeId);
    }
  }

  /**
   * Test hook. The next webhook call records the scheduling rows, then stops
   * the send without a retry. Evicting the object drops the in-memory attempt.
   * Storage stays.
   */
  resetNextWakeSend(): void {
    this.resetNextSend = true;
  }

  /**
   * Record wake POSTs inside the object and answer them with `status`.
   * Production leaves this unset and uses the real fetch.
   */
  recordWakeFetches(status: number): void {
    this.recordedFetches = [];
    this.recordedStatus = status;
    this.alarmsDuringFetch = new Map();
    this.fetchOverride = async (input, init) => {
      const request = new Request(input, init);
      const wakeId = request.headers.get(WAKE_HEADER_WAKE_ID);
      if (wakeId) this.alarmsDuringFetch.set(wakeId, this.wakeAlarmRows());
      const body = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      this.recordedFetches.push({ url: request.url, method: request.method, body, headers });
      return new Response("ok", { status: this.recordedStatus });
    };
  }

  setRecordedWakeStatus(status: number): void {
    this.recordedStatus = status;
  }

  wakeFetches(): WakeFetchRecord[] {
    return this.recordedFetches.map((row) => ({ ...row, headers: { ...row.headers } }));
  }

  /** Scheduling rows seen while this wake's webhook request was in flight. */
  alarmsDuringFetchFor(wakeId: string): { wakeId: string; dueMs: number }[] {
    return (this.alarmsDuringFetch.get(wakeId) ?? []).map((row) => ({ ...row }));
  }

  /** Keep fallback mail in the object. The signing secret is not part of the message. */
  captureWakeMail(): void {
    this.capturedMail = [];
    this.mailOverride = (email) => {
      this.capturedMail.push(email);
      return Promise.resolve();
    };
  }

  wakeMail(): WakeEmail[] {
    return this.capturedMail.map((email) => ({ ...email }));
  }

  /**
   * Check a captured webhook inside the object.
   * The signing secret is not returned.
   */
  wakeSignatureMatches(agentId: string, timestamp: string, rawBody: string, signature: string): boolean {
    const secret = signingSecretFor(this.deps.db, "agent", agentId);
    return verifyWakeSignature({ secret, timestamp, rawBody, signature, nowMs: Date.now() });
  }

  clearWakeTestHooks(): void {
    this.fetchOverride = undefined;
    this.mailOverride = undefined;
    this.recordedFetches = [];
    this.capturedMail = [];
    this.recordedStatus = 200;
    this.alarmsDuringFetch = new Map();
    this.resetNextSend = false;
  }
}

function applyPublicBindings(env: CommonaEnv): void {
  if (typeof env.COMMONA_PUBLIC_ORIGIN === "string") process.env.COMMONA_PUBLIC_ORIGIN = env.COMMONA_PUBLIC_ORIGIN;
  if (typeof env.COMMONA_CONNECT_URL === "string") process.env.COMMONA_CONNECT_URL = env.COMMONA_CONNECT_URL;
}
