import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  isId,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_WAKE_ID,
  type WakeEvent,
} from "../../contract/index.js";
import type { WakeHandoff } from "./handoff.js";
import { isWakeEvent } from "./spool.js";

const BODY_LIMIT = 1_048_576;

export interface WakeListener {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function startWakeListener(options: {
  handoff: WakeHandoff;
  host?: string;
  port?: number;
}): Promise<WakeListener> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handle(request, response, options.handoff);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("wake listener did not bind a TCP port"));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, handoff: WakeHandoff): Promise<void> {
  try {
    if (request.method !== "POST") return send(response, 405, { error: { code: "validation", message: "POST only." } });
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/wake" && pathname !== "/") {
      return send(response, 404, { error: { code: "not_found", message: "Not found." } });
    }
    const event = await readEvent(request);
    await handoff.deliver(event);
    response.writeHead(204);
    response.end();
  } catch (error) {
    const status = error instanceof ListenerError ? error.status : 500;
    const message = error instanceof Error ? error.message : "wake handoff failed";
    send(response, status, { error: { code: status === 400 ? "validation" : "error", message } });
  }
}

async function readEvent(request: IncomingMessage): Promise<WakeEvent> {
  const text = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ListenerError(400, "wake body is not JSON");
  }
  if (!isWakeEvent(parsed)) throw new ListenerError(400, "wake body is not a commona.wake event");
  const headerEvent = header(request, WAKE_HEADER_EVENT);
  const headerWakeId = header(request, WAKE_HEADER_WAKE_ID);
  const headerRoomId = header(request, WAKE_HEADER_ROOM_ID);
  if (headerEvent !== WAKE_EVENT_TYPE) throw new ListenerError(400, "X-Commona-Event must be commona.wake");
  if (!headerWakeId || !isId(headerWakeId) || headerWakeId !== parsed.wakeId) {
    throw new ListenerError(400, "X-Commona-Wake-Id does not match the body");
  }
  if (!headerRoomId || !isId(headerRoomId) || headerRoomId !== parsed.roomId) {
    throw new ListenerError(400, "X-Commona-Room-Id does not match the body");
  }
  if (parsed.disclosure === "activity_only" && parsed.content !== undefined) {
    throw new ListenerError(400, "an activity-only wake must omit content");
  }
  return parsed;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT) {
        reject(new ListenerError(400, "wake body is too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new ListenerError(400, "wake body could not be read")));
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

class ListenerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ListenerError";
    this.status = status;
  }
}
