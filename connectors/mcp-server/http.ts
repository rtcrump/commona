import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig, type ConnectorConfig } from "./config.js";
import { createMcpServer, type JsonRpcNotification, type McpServer } from "./server.js";
import { isDirectRun } from "../../src/listener/run.js";

const BODY_LIMIT = 1_048_576;

export interface McpHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Session {
  server: McpServer;
  sse: ServerResponse | null;
}

/**
 * Streamable HTTP MCP endpoint at `/mcp`.
 * One process serves one agent. Bind stays on loopback unless COMMONA_MCP_BEARER is set.
 */
export function startMcpHttp(options: {
  config: ConnectorConfig;
  host?: string;
  port?: number;
  bearer?: string;
  allowedOrigins?: string[];
  fetchImpl?: typeof fetch;
}): Promise<McpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host) && !options.bearer) {
    return Promise.reject(new Error("COMMONA_MCP_BEARER is required when COMMONA_MCP_HOST is not loopback."));
  }
  const sessions = new Map<string, Session>();
  const server = createServer((request, response) => {
    void handle(request, response, {
      config: options.config,
      bearer: options.bearer,
      allowedOrigins: options.allowedOrigins ?? [],
      fetchImpl: options.fetchImpl,
      sessions,
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("mcp http server did not bind a TCP port"));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}/mcp`,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            for (const session of sessions.values()) {
              session.server.close();
              session.sse?.end();
            }
            sessions.clear();
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: {
    config: ConnectorConfig;
    bearer?: string;
    allowedOrigins: string[];
    fetchImpl?: typeof fetch;
    sessions: Map<string, Session>;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/mcp") {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (!originAllowed(request, ctx.allowedOrigins)) {
    json(response, 403, { error: "origin" });
    return;
  }
  if (ctx.bearer && !bearerMatches(request, ctx.bearer)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "DELETE") {
    const id = sessionId(request);
    const session = id ? ctx.sessions.get(id) : undefined;
    if (!session) {
      json(response, 404, { error: "session" });
      return;
    }
    session.server.close();
    session.sse?.end();
    ctx.sessions.delete(id as string);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET") {
    openSse(request, response, ctx.sessions);
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, { error: "method" });
    return;
  }
  if (!acceptsJson(request)) {
    json(response, 406, { error: "accept" });
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(await readBody(request)) as unknown;
  } catch {
    json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    return;
  }
  const method = methodOf(message);
  const existingId = sessionId(request);
  let session = existingId ? ctx.sessions.get(existingId) : undefined;
  if (method === "initialize") {
    if (session) {
      session.server.close();
      session.sse?.end();
      ctx.sessions.delete(existingId as string);
    }
    const id = randomUUID();
    const created = createMcpServer(ctx.config, ctx.fetchImpl);
    session = { server: created, sse: null };
    created.onNotification((note) => writeSse(session as Session, note));
    ctx.sessions.set(id, session);
    const result = await created.handle(message);
    json(response, 200, result, { "mcp-session-id": id });
    return;
  }
  if (!session) {
    json(response, 400, { error: "session" });
    return;
  }
  const result = await session.server.handle(message);
  if (!result) {
    response.writeHead(202);
    response.end();
    return;
  }
  json(response, 200, result, existingId ? { "mcp-session-id": existingId } : {});
}

function openSse(request: IncomingMessage, response: ServerResponse, sessions: Map<string, Session>): void {
  const accept = request.headers.accept ?? "";
  if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
    json(response, 406, { error: "accept" });
    return;
  }
  const id = sessionId(request);
  const session = id ? sessions.get(id) : undefined;
  if (!session) {
    json(response, 400, { error: "session" });
    return;
  }
  if (session.sse) session.sse.end();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(id ? { "mcp-session-id": id } : {}),
  });
  response.write(": open\n\n");
  session.sse = response;
  response.on("close", () => {
    if (session.sse === response) session.sse = null;
  });
}

function writeSse(session: Session, message: JsonRpcNotification): void {
  if (!session.sse) return;
  try {
    session.sse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  } catch {
    session.sse = null;
  }
}

function originAllowed(request: IncomingMessage, allowed: string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function bearerMatches(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)$/.exec(value ?? "");
  if (!match?.[1]) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function sessionId(request: IncomingMessage): string | undefined {
  const header = request.headers["mcp-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.length > 0 ? value : undefined;
}

function acceptsJson(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  if (!accept) return true;
  return accept.includes("application/json") || accept.includes("*/*");
}

function methodOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new Error("body unreadable")));
  });
}

function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...extra });
  response.end(JSON.stringify(body));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.baseUrl) throw new Error("COMMONA_BASE_URL is not set.");
  const host = process.env.COMMONA_MCP_HOST?.trim() || "127.0.0.1";
  const port = process.env.COMMONA_MCP_PORT ? Number(process.env.COMMONA_MCP_PORT) : 0;
  const bearer = process.env.COMMONA_MCP_BEARER?.trim() || undefined;
  const allowed = (process.env.COMMONA_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const http = await startMcpHttp({ config, host, port, bearer, allowedOrigins: allowed });
  process.stderr.write(`commona mcp ${http.url}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void http.close().then(() => resolve(), () => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "mcp http server failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
