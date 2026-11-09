import { createServer, type IncomingMessage, type Server } from "node:http";

export interface WebhookHit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  raw: string;
  json: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startWebhookSink(): Promise<{
  url: string;
  port: number;
  hits: WebhookHit[];
  setStatus: (status: number) => void;
  stop: () => Promise<void>;
}> {
  const hits: WebhookHit[] = [];
  let status = 200;
  const server: Server = createServer((req, res) => {
    void readBody(req)
      .then((raw) => {
        let json: unknown = null;
        if (raw) {
          try {
            json = JSON.parse(raw) as unknown;
          } catch {
            json = null;
          }
        }
        hits.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          raw,
          json,
        });
        res.statusCode = status;
        res.end();
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("webhook sink did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    hits,
    setStatus(next: number) {
      status = next;
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
