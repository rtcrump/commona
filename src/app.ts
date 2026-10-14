import Fastify, { type FastifyInstance } from "fastify";
import { systemClock, type Clock, type HealthResponse } from "../contract/index.js";
import { createAuditLog, registerLogRoute } from "./audit/index.js";
import { openDatabase } from "./db.js";

type Sqlite = ReturnType<typeof openDatabase>;

export interface BuildAppOptions {
  /** Shared database. When omitted, opens `COMMONA_DB` or an in-memory database. */
  db?: Sqlite;
  clock?: Clock;
}

/** Health and the audit log. Room, sharing, guard, and wake routes are later specs. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = options.db ?? openDatabase(process.env.COMMONA_DB ?? ":memory:");
  const clock = options.clock ?? systemClock;
  const ownsDb = options.db === undefined;
  registerLogRoute(app, { db, audit: createAuditLog(db, clock), clock });
  app.get("/health", async (): Promise<HealthResponse> => ({ ok: true, service: "commona" }));
  if (ownsDb) {
    app.addHook("onClose", async () => {
      db.close();
    });
  }
  return app;
}
