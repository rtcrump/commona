import { Hono } from "hono";
import { ApiErrorCode, MAX_FILE_BYTES } from "../../contract/index.js";
import { registerLogRoute } from "../audit/route.js";
import { registerHostRoute } from "../host/host-room.js";
import { registerInviteRoutes } from "../join/routes.js";
import { registerNoticeRoute } from "../notices/route.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { registerRoomRoutes } from "../room/routes.js";
import type { AppEnv, CommonaHono } from "./types.js";

/** Largest request body. A file is base64, so the cap sits above one max file plus form overhead. */
export const BODY_LIMIT = Math.ceil((MAX_FILE_BYTES + 1) * (4 / 3)) + 65_536;

/** Room HTTP API. The same app runs in Node and inside the Durable Object. */
export function createHttpApp(deps: RoomDeps): CommonaHono {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      c.set("parsedBody", undefined);
      await next();
      return;
    }
    if (contentLengthOverLimit(c.req.header("content-length"))) return payloadTooLarge();
    const raw = await readCappedBody(c.req.raw);
    if (raw instanceof Response) return raw;
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

function contentLengthOverLimit(header: string | undefined): boolean {
  if (header === undefined) return false;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  return BigInt(trimmed) > BigInt(BODY_LIMIT);
}

function payloadTooLarge(): Response {
  const error = new RoomHttpError(413, ApiErrorCode.Validation);
  return Response.json(error.body(), { status: 413 });
}

/** Read the body, and stop once it passes the cap. A declared Content-Length is not trusted. */
async function readCappedBody(request: Request): Promise<ArrayBuffer | Response> {
  const body = request.body;
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > BODY_LIMIT) {
      await reader.cancel();
      return payloadTooLarge();
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw.buffer;
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
