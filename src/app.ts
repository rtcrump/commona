import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "../contract/index.js";

/** Health only. Room, sharing, guard, and wake routes are later specs. */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async (): Promise<HealthResponse> => ({ ok: true, service: "commona" }));
  return app;
}
