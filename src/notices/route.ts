import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  ReasonCode,
  UNSCOPED_ROOM,
  formatTimestamp,
  readBearerToken,
  type AuditLog,
  type Clock,
  type TokenStore,
} from "../../contract/index.js";
import { RoomHttpError } from "../room/http.js";
import { listNotices } from "./store.js";

export interface NoticeRouteDeps {
  db: Database.Database;
  tokens: TokenStore;
  audit: AuditLog;
  clock: Clock;
}

/**
 * `GET /notices` returns the caller's notices, oldest first.
 * A successful read is not audited. An agent is `403` and that refusal is.
 */
export function registerNoticeRoute(app: FastifyInstance, deps: NoticeRouteDeps): void {
  app.get("/notices", async (request) => {
    const header = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const token = readBearerToken(header);
    if (!token) throw RoomHttpError.unauthorized();
    const principal = deps.tokens.authenticate(token);
    if (!principal) throw RoomHttpError.unauthorized();
    if (principal.kind !== "owner") {
      deps.audit.append({
        ts: formatTimestamp(deps.clock.now()),
        room: UNSCOPED_ROOM,
        agentId: principal.agentId,
        ownerId: principal.ownerId,
        action: AuditAction.Read,
        result: AuditResult.Refused,
        detail: { reasonCode: ReasonCode.NotOwner },
      });
      throw RoomHttpError.forbidden(ReasonCode.NotOwner);
    }
    return { notices: listNotices(deps.db, principal.ownerId) };
  });
}
