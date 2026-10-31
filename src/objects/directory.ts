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
import { rememberBriefPostCap as writeBriefPostCap } from "../agent-api/limit.js";
import { feedRoomId, reserveAgentPoll } from "../poll/agent-poll.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { createSharingDirectory } from "../sharing/index.js";

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

export class DirectoryObject extends DurableObject<CommonaEnv> {
  private deps!: RoomDeps;
  private app!: CommonaHono;

  constructor(ctx: DurableObjectState, env: CommonaEnv) {
    super(ctx, env);
    this.boot();
  }

  /** Open SQLite, then build the HTTP app. */
  private boot(): void {
    const db = createSqliteDatabase(new DurableSqlDriver(this.storage()));
    try {
      db.pragma("foreign_keys = ON");
    } catch {
      // The Durable Object opens with foreign keys available.
    }
    prepareDatabase(db);
    const clock = systemClock;
    const deps: RoomDeps = {
      db,
      clock,
      tokens: createTokenStore(db),
      audit: createAuditLog(db, clock),
      sharing: createSharingDirectory(db),
      guard,
      notices: createOwnerNotifier(db, clock),
      clearAlarmIfEmpty: () => this.clearAlarmIfEmpty(),
    };
    this.deps = deps;
    this.app = createHttpApp(deps);
  }

  /**
   * The alarm belongs to the whole object. Clear it only when no rooms remain,
   * and hold other requests so a new room cannot set one in between.
   */
  private async clearAlarmIfEmpty(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const row = this.deps.db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number } | undefined;
      if (Number(row?.n ?? 0) !== 0) return;
      await this.storage().deleteAlarm();
    });
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

  /** Test helper. Stores the brief's per-task post cap for one room. */
  rememberBriefPostCap(roomId: string, postCap: number): void {
    writeBriefPostCap(this.deps.db, roomId, postCap);
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
}

function applyPublicBindings(env: CommonaEnv): void {
  if (typeof env.COMMONA_PUBLIC_ORIGIN === "string") process.env.COMMONA_PUBLIC_ORIGIN = env.COMMONA_PUBLIC_ORIGIN;
  if (typeof env.COMMONA_CONNECT_URL === "string") process.env.COMMONA_CONNECT_URL = env.COMMONA_CONNECT_URL;
}
