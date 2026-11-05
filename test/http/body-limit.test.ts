import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db.js";
import { BODY_LIMIT } from "../../src/http/server.js";

const tooLarge = { error: { code: "validation", message: "Invalid request." } };

describe("request body limit", () => {
  it("returns 413 before reading when Content-Length is over the limit", async () => {
    const db = openDatabase(":memory:");
    const app = buildApp({ db, smtp: null });
    try {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([0]));
        },
      });
      const request = streamRequest(body, { "content-length": String(BODY_LIMIT + 1) });
      await Promise.resolve();
      const prefetched = pulls;
      const response = await app.fetch(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(tooLarge);
      expect(prefetched).toBeLessThanOrEqual(1);
      expect(pulls).toBe(prefetched);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns 413 and stops reading once the streamed body passes the limit", async () => {
    const db = openDatabase(":memory:");
    const app = buildApp({ db, smtp: null });
    try {
      const chunk = new Uint8Array(64 * 1024);
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = await app.fetch(streamRequest(body, { "content-length": "1" }));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(tooLarge);
      const pulled = pulls * chunk.byteLength;
      expect(pulled).toBeGreaterThan(BODY_LIMIT);
      expect(pulled).toBeLessThanOrEqual(BODY_LIMIT + chunk.byteLength);
      expect(cancelled).toBe(true);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("still accepts a small body", async () => {
    const db = openDatabase(":memory:");
    const app = buildApp({ db, smtp: null });
    try {
      const response = await app.fetch(
        new Request("https://room.example.test/health", {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "2" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      await app.close();
      db.close();
    }
  });
});

function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string>): Request {
  return new Request("https://room.example.test/health", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body,
    duplex: "half",
  });
}
