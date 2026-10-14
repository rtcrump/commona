import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import {
  MAX_FILE_BYTES,
  systemClock,
  type AuditLog,
  type Clock,
  type ContentGuard,
  type HealthResponse,
  type SharingDirectory,
  type TokenStore,
  type WakeQueue,
} from "../contract/index.js";
import { createAuditLog, registerLogRoute } from "./audit/index.js";
import { createTokenStore } from "./auth/index.js";
import { openDatabase } from "./db.js";
import { guard } from "./guard/index.js";
import type { RoomDeps } from "./room/deps.js";
import { RoomHttpError } from "./room/http.js";
import { registerRoomRoutes } from "./room/routes.js";
import { createSharingDirectory } from "./sharing/index.js";

export interface BuildAppOptions {
  db?: Database.Database;
  clock?: Clock;
  tokens?: TokenStore;
  audit?: AuditLog;
  sharing?: SharingDirectory;
  guard?: ContentGuard;
  /**
   * Pass a queue to enqueue wakes after an accepted post or file.
   * Omitted until the caller attaches the wake-up service.
   */
  wakeQueue?: WakeQueue;
}

/** Room routes plus the audit log. The default database is `COMMONA_DB`, or memory when unset. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(process.env.COMMONA_DB ?? ":memory:");
  const clock = options.clock ?? systemClock;
  const audit = options.audit ?? createAuditLog(db, clock);
  const deps: RoomDeps = {
    db,
    clock,
    tokens: options.tokens ?? createTokenStore(db),
    audit,
    sharing: options.sharing ?? createSharingDirectory(db),
    guard: options.guard ?? guard,
    ...(options.wakeQueue ? { wakeQueue: options.wakeQueue } : {}),
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
  if (ownsDb) {
    app.addHook("onClose", async () => {
      db.close();
    });
  }
  return app;
}

function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode;
  }
  return 500;
}
