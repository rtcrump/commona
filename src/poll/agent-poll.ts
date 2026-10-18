import { hashToken, readBearerToken } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";

/** Fixed gap. It is not read from the environment. */
export const POLL_MIN_MS = 30_000;

const FEED_PATH = /^\/rooms\/[^/]+\/feed$/;

export function isAgentFeedPoll(method: string, pathname: string): boolean {
  return method === "GET" && FEED_PATH.test(pathname);
}

/**
 * One poll per agent key per 30 seconds. Owners are not limited.
 * An unknown token is not limited here; the route answers 401.
 * The stored value is the SHA-256 hash, never the key.
 * Returns 429, or null when the request may continue.
 */
export function reserveAgentPoll(deps: RoomDeps, authorization: string | undefined, nowMs: number): Response | null {
  const token = readBearerToken(authorization);
  if (!token) return null;
  const hash = hashToken(token);
  const agent = deps.db.prepare("SELECT id FROM agents WHERE token_hash = ?").get(hash) as { id: string } | undefined;
  if (!agent) return null;
  const row = deps.db.prepare("SELECT last_ms FROM agent_polls WHERE token_hash = ?").get(hash) as
    | { last_ms: number }
    | undefined;
  if (row && nowMs - Number(row.last_ms) < POLL_MIN_MS) {
    return new Response(JSON.stringify({ error: { code: "validation", message: "Try again later." } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "30",
        "cache-control": "no-store",
      },
    });
  }
  deps.db
    .prepare(
      `INSERT INTO agent_polls (token_hash, last_ms) VALUES (?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET last_ms = excluded.last_ms`,
    )
    .run(hash, nowMs);
  return null;
}
