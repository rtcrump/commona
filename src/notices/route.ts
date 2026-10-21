import type Database from "better-sqlite3";
import {
  AuditAction,
  AuditResult,
  ReasonCode,
  UNSCOPED_ROOM,
  formatTimestamp,
  principalActor,
  readBearerToken,
  type AuditLog,
  type Clock,
  type TokenStore,
} from "../../contract/index.js";
import type { CommonaHono } from "../http/types.js";
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
export function registerNoticeRoute(app: CommonaHono, deps: NoticeRouteDeps): void {
  app.get("/notices", (c) => {
    const token = readBearerToken(c.req.header("authorization"));
    if (!token) throw RoomHttpError.unauthorized();
    const principal = deps.tokens.authenticate(token);
    if (!principal) throw RoomHttpError.unauthorized();
    if (principal.kind !== "owner") {
      const actor = principalActor(principal);
      deps.audit.append({
        ts: formatTimestamp(deps.clock.now()),
        room: UNSCOPED_ROOM,
        agentId: actor.agentId,
        ownerId: actor.ownerId,
        action: AuditAction.Read,
        result: AuditResult.Refused,
        detail: { reasonCode: ReasonCode.NotOwner },
      });
      throw RoomHttpError.forbidden(ReasonCode.NotOwner);
    }
    return c.json({ notices: listNotices(deps.db, principal.ownerId) });
  });
}
