import readline from "node:readline";
import { loadConfig } from "./config.js";
import { createMcpServer, type JsonRpcNotification } from "./server.js";
import { isDirectRun } from "../../src/listener/run.js";

export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  if (!config.baseUrl) {
    process.stderr.write("COMMONA_BASE_URL is not set.\n");
    process.exit(1);
  }
  const server = createMcpServer(config);
  let writes = Promise.resolve();
  const write = (message: unknown) => {
    const line = `${JSON.stringify(message)}\n`;
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return writes;
  };
  server.onNotification((message: JsonRpcNotification) => {
    void write(message);
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    chain = chain
      .then(async () => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: unknown;
        try {
          message = JSON.parse(trimmed) as unknown;
        } catch {
          await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
          return;
        }
        const response = await server.handle(message);
        if (response) await write(response);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "mcp request failed";
        process.stderr.write(`${message}\n`);
      });
  });
  await new Promise<void>((resolve) => {
    lines.once("close", () => resolve());
  });
  await chain;
  await writes;
  server.close();
}

if (isDirectRun(import.meta.url)) {
  runStdio().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "mcp server failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
