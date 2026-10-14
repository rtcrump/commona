import { buildApp } from "../../src/app.js";

export async function startTestServer(): Promise<{
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const app = buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: () => app.close(),
  };
}
