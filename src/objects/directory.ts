import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { systemClock } from "../../contract/index.js";
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
import { isAgentFeedPoll, reserveAgentPoll } from "../poll/agent-poll.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { createSharingDirectory } from "../sharing/index.js";

/**
 * One SQLite Durable Object for the whole server.
 * Rooms, keys, invites, and the audit chain stay in one database, which is
 * what the Node server did. The free plan only offers this SQLite kind.
 */
export class DirectoryObject extends DurableObject<CommonaEnv> {
  private readonly deps: RoomDeps;
  private readonly app: CommonaHono;

  constructor(ctx: DurableObjectState, env: CommonaEnv) {
    super(ctx, env);
    const db = createSqliteDatabase(new DurableSqlDriver(ctx.storage as unknown as DurableSqlStorage));
    try {
      db.pragma("foreign_keys = ON");
    } catch {
      // The Durable Object opens with foreign keys available.
    }
    prepareDatabase(db);
    const clock = systemClock;
    this.deps = {
      db,
      clock,
      tokens: createTokenStore(db),
      audit: createAuditLog(db, clock),
      sharing: createSharingDirectory(db),
      guard,
      notices: createOwnerNotifier(db, clock),
    };
    this.app = createHttpApp(this.deps);
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
    if (isAgentFeedPoll(request.method, url.pathname)) {
      const limited = reserveAgentPoll(this.deps, request.headers.get("authorization") ?? undefined, Date.now());
      if (limited) return limited;
    }
    applyPublicBindings(this.env);
    return useHostSecret(this.env.COMMONA_HOST_SECRET, () => Promise.resolve(this.app.fetch(request)));
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
}

function applyPublicBindings(env: CommonaEnv): void {
  if (typeof env.COMMONA_PUBLIC_ORIGIN === "string") process.env.COMMONA_PUBLIC_ORIGIN = env.COMMONA_PUBLIC_ORIGIN;
  if (typeof env.COMMONA_CONNECT_URL === "string") process.env.COMMONA_CONNECT_URL = env.COMMONA_CONNECT_URL;
}
