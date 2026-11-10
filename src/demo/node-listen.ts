import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleDemoRequest, type DemoEnv } from "./handler.js";

const MAX_BODY = 65_536;

export interface DemoListener {
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** Local listener for the public demo. It binds the loopback interface only. */
export function listenDemo(env: DemoEnv = {}, host = "127.0.0.1", port = 0): Promise<DemoListener> {
  const server = createServer((req, res) => {
    void serve(req, res, env);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("demo server did not bind"));
        return;
      }
      resolve({
        origin: `http://${host}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function serve(req: IncomingMessage, res: ServerResponse, env: DemoEnv): Promise<void> {
  try {
    const host = req.headers.host ?? "127.0.0.1";
    const body = await readBody(req);
    if (body === undefined) {
      res.writeHead(413, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("This demo does not accept a large upload.");
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    const request = new Request(`http://${host}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      duplex: body.length > 0 ? "half" : undefined,
    });
    const response = await handleDemoRequest(request, env);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const outgoing = new Map<string, string | string[]>();
    response.headers.forEach((value, key) => {
      if (key === "set-cookie") return;
      outgoing.set(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.set("set-cookie", cookies);
    res.writeHead(response.status, Object.fromEntries(outgoing));
    res.end(bytes);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("The demo could not answer.");
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}
