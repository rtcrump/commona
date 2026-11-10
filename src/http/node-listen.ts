import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface NodeListener {
  server: Server;
  close(): Promise<void>;
}

/** Serve a fetch handler on a local TCP port for the Node tests. */
export function listenNode(
  fetchImpl: (request: Request) => Promise<Response>,
  host: string,
  port: number,
): Promise<NodeListener> {
  const server = createServer((req, res) => {
    void relay(req, res, fetchImpl);
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      resolve({
        server,
        close: () =>
          new Promise((done, stopFailed) => {
            server.close((error) => (error ? stopFailed(error) : done()));
          }),
      });
    });
  });
}

async function relay(
  req: IncomingMessage,
  res: ServerResponse,
  fetchImpl: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    const method = req.method ?? "GET";
    const request = new Request(url, {
      method,
      headers,
      body: body.byteLength > 0 && method !== "GET" && method !== "HEAD" ? body : undefined,
    });
    const response = await fetchImpl(request);
    res.statusCode = response.status;
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      res.setHeader(key, value);
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    res.end(bytes);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "validation", message: "Request failed." } }));
    } else {
      res.end();
    }
  }
}

export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") return 0;
  return (address as AddressInfo).port;
}
