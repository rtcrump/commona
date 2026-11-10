import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/index.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

const origin = "https://join.example.test";
const hostSecret = "host-test-secret";
const title = "Sunday lunch";
const hostName = "Host (demo)";

describe("hosted room labels", () => {
  const previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;
  const previousSecret = process.env.COMMONA_HOST_SECRET;

  afterEach(() => {
    if (previousOrigin === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previousOrigin;
    if (previousSecret === undefined) delete process.env.COMMONA_HOST_SECRET;
    else process.env.COMMONA_HOST_SECRET = previousSecret;
  });

  it("refuses a fixture patient name in the title or the host display name", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    process.env.COMMONA_HOST_SECRET = hostSecret;
    const db = openDatabase(":memory:");
    const tokens = createTokenStore(db);
    const audit = createAuditLog(db, { now: () => new Date("2026-04-01T12:00:00.000Z") });
    const app = buildApp({ db, clock: { now: () => new Date("2026-04-01T12:00:00.000Z") }, tokens, audit, sharing: createSharingDirectory(db) });
    const listed = listedName();
    try {
      const roomsBefore = count(db, "SELECT COUNT(*) AS n FROM rooms");
      const ownersBefore = count(db, "SELECT COUNT(*) AS n FROM owners");
      for (const payload of [
        { title: listed, hostName, inviteCount: 1 },
        { title, hostName: listed, inviteCount: 1 },
      ]) {
        const refused = await postRoom(app, payload);
        expect(refused.status).not.toBe(201);
        expect(refused.status).toBe(400);
        const text = await refused.text();
        expect(text.includes(listed)).toBe(false);
        expect(count(db, "SELECT COUNT(*) AS n FROM rooms")).toBe(roomsBefore);
        expect(count(db, "SELECT COUNT(*) AS n FROM owners")).toBe(ownersBefore);
      }

      const created = await postRoom(app, { title, hostName, inviteCount: 1 });
      expect(created.status).toBe(201);
      expect(count(db, "SELECT COUNT(*) AS n FROM rooms")).toBe(roomsBefore + 1);
    } finally {
      await app.close();
      db.close();
    }
  });
});

function listedName(): string {
  const text = readFileSync(new URL("../../fixtures/names.txt", import.meta.url), "utf8");
  const name = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!name) throw new Error("fixtures/names.txt has no name");
  return name;
}

function count(db: ReturnType<typeof openDatabase>, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return Number(row.n);
}

function postRoom(app: ReturnType<typeof buildApp>, payload: unknown): Promise<Response> {
  return app.fetch(
    new Request(`${origin}/host/room`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOST_SECRET_HEADER]: hostSecret },
      body: JSON.stringify(payload),
    }),
  );
}
