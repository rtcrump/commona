import { Hono } from "hono";
import { MAX_FILE_BYTES } from "../../contract/index.js";
import { registerLogRoute } from "../audit/route.js";
import { registerHostRoute } from "../host/host-room.js";
import { registerInviteRoutes } from "../join/routes.js";
import { registerNoticeRoute } from "../notices/route.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { registerRoomRoutes } from "../room/routes.js";
import type { AppEnv, CommonaHono } from "./types.js";

const BODY_LIMIT = Math.ceil((MAX_FILE_BYTES + 1) * (4 / 3)) + 65_536;

/** Room HTTP API. The same app runs in Node and inside the Durable Object. */
export function createHttpApp(deps: RoomDeps): CommonaHono {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      c.set("parsedBody", undefined);
      await next();
      return;
    }
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > BODY_LIMIT) throw RoomHttpError.badRequest();
    c.set("parsedBody", parseBody(c.req.header("content-type"), raw));
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof RoomHttpError) return c.json(error.body(), error.status as 400);
    const statusCode = statusOf(error);
    if (statusCode === 400 || statusCode === 413) return c.json(RoomHttpError.badRequest().body(), 400);
    if (statusCode === 404) return c.json(RoomHttpError.notFound().body(), 404);
    return c.json({ error: { code: "validation", message: "Request failed." } }, statusCode as 500);
  });
  app.notFound((c) => c.json(RoomHttpError.notFound().body(), 404));
  app.get("/health", (c) => c.json({ ok: true, service: "commona" }));
  registerHostRoute(app, deps);
  registerRoomRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerLogRoute(app, { db: deps.db, audit: deps.audit, clock: deps.clock });
  registerNoticeRoute(app, { db: deps.db, tokens: deps.tokens, audit: deps.audit, clock: deps.clock });
  return app;
}

function parseBody(contentType: string | undefined, raw: ArrayBuffer): unknown {
  if (raw.byteLength === 0) return undefined;
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const text = new TextDecoder().decode(raw);
  if (type === "application/json") {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw RoomHttpError.badRequest();
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(text);
    const record: Record<string, string> = {};
    for (const [key, value] of params) {
      if (record[key] === undefined) record[key] = value;
    }
    return record;
  }
  return undefined;
}

function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode;
  }
  return 500;
}
