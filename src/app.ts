import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import {
  MAX_FILE_BYTES,
  systemClock,
  type AuditLog,
  type Clock,
  type ContentGuard,
  type HealthResponse,
  type OwnerNotifier,
  type SharingDirectory,
  type TokenStore,
  type WakeQueue,
} from "../contract/index.js";
import { createAuditLog, registerLogRoute } from "./audit/index.js";
import { createTokenStore } from "./auth/index.js";
import { createPrivacyGuard } from "./guard/index.js";
import { createOwnerNotifier, registerNoticeRoute } from "./notices/index.js";
import type { RoomDeps } from "./room/deps.js";
import { RoomHttpError } from "./room/http.js";
import { registerRoomRoutes } from "./room/routes.js";
import { closeDefaultRuntime, defaultRuntime } from "./runtime.js";
import { createSharingDirectory } from "./sharing/index.js";
import type { SmtpEndpoint } from "./wakeup/smtp.js";

export interface BuildAppOptions {
  db?: Database.Database;
  clock?: Clock;
  tokens?: TokenStore;
  audit?: AuditLog;
  sharing?: SharingDirectory;
  guard?: ContentGuard;
  notices?: OwnerNotifier;
  /**
   * Pass a queue to enqueue wakes after an accepted post or file.
   * The no-argument app uses the wake-up service and delivers those wakes.
   */
  wakeQueue?: WakeQueue;
  /** When set, accepted wakes are delivered. Ignored when `wakeQueue` is injected. */
  deliverWake?: (wakeId: string) => Promise<void>;
  /** `null` leaves email unconfigured. Omit it to read COMMONA_SMTP_HOST and COMMONA_SMTP_PORT. */
  smtp?: SmtpEndpoint | null;
}

/**
 * The no-argument app is what the harness starts. It opens COMMONA_DB (or memory),
 * wires auth, audit, sharing, the name block, notices, and wake-up, and delivers
 * to the webhook URLs stored on the agents.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const shared = options.db === undefined ? defaultRuntime() : undefined;
  const db = options.db ?? shared!.db;
  const clock = options.clock ?? shared?.clock ?? systemClock;
  const audit = options.audit ?? shared?.audit ?? createAuditLog(db, clock);
  const tokens = options.tokens ?? shared?.tokens ?? createTokenStore(db);
  const notices = options.notices ?? shared?.notices ?? createOwnerNotifier(db, clock);
  const smtp = resolveSmtp(options, shared?.smtp);
  const wakeQueue = options.wakeQueue ?? shared?.wake;
  const deliverWake = options.wakeQueue ? options.deliverWake : shared ? deliverWith(shared.wake) : options.deliverWake;
  const deps: RoomDeps = {
    db,
    clock,
    tokens,
    audit,
    sharing: options.sharing ?? shared?.sharing ?? createSharingDirectory(db),
    guard: options.guard ?? shared?.guard ?? createPrivacyGuard(db),
    notices,
    ...(wakeQueue ? { wakeQueue } : {}),
    ...(deliverWake ? { deliverWake } : {}),
    ...(smtp ? { smtp } : {}),
  };
  const app = Fastify({
    logger: false,
    // Base64 expands a file by 4/3. Leave room for a just-over-limit body so the route can answer 400.
    bodyLimit: Math.ceil((MAX_FILE_BYTES + 1) * (4 / 3)) + 65_536,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomHttpError) {
      return reply.status(error.status).send(error.body());
    }
    const statusCode = statusOf(error);
    if (statusCode === 400 || statusCode === 413) return reply.status(400).send(RoomHttpError.badRequest().body());
    if (statusCode === 404) return reply.status(404).send(RoomHttpError.notFound().body());
    return reply.status(statusCode).send({
      error: { code: "validation", message: "Request failed." },
    });
  });
  app.get("/health", async (): Promise<HealthResponse> => ({ ok: true, service: "commona" }));
  registerRoomRoutes(app, deps);
  registerLogRoute(app, { db, audit, clock });
  registerNoticeRoute(app, { db, tokens, audit, clock });
  if (shared) {
    app.addHook("onClose", async () => {
      closeDefaultRuntime();
    });
  }
  return app;
}

function resolveSmtp(options: BuildAppOptions, shared: SmtpEndpoint | undefined): SmtpEndpoint | undefined {
  if (options.smtp === null) return undefined;
  if (options.smtp) return options.smtp;
  return shared;
}

function deliverWith(wake: { deliver(wakeId: string): Promise<unknown> }): (wakeId: string) => Promise<void> {
  return (wakeId) => wake.deliver(wakeId).then(() => undefined);
}

function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode;
  }
  return 500;
}
