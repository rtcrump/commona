import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../../contract/index.js";
import { buildApp } from "../../src/app.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { createPrivacyGuard } from "../../src/guard/index.js";
import { send } from "../room/server.js";

describe("privacy filter schema", () => {
  it("accepts an ordinary post and upload when the database was built from SCHEMA_SQL alone", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'privacy_filters'").get()).toEqual({
      name: "privacy_filters",
    });
    db.prepare(
      "INSERT INTO owners (id, email, display_name, role) VALUES ('O1', 'o1@example.test', 'Owner One', 'participant')",
    ).run();
    db.prepare(
      "INSERT INTO agents (id, owner_id, display_name, email) VALUES ('A1', 'O1', 'Agent One', 'a1@example.test')",
    ).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM privacy_filters").get()).toEqual({ n: 0 });

    const tokens = createTokenStore(db);
    const app = buildApp({ db, tokens, smtp: null });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const ownerToken = tokens.issueOwnerToken("O1");
      const created = await send(baseUrl, "POST", "/rooms", ownerToken, {});
      expect(created.status).toBe(201);
      const roomId = roomIdOf(created.body);
      const joined = await send(baseUrl, "POST", `/rooms/${roomId}/members`, ownerToken, { agentId: "A1" });
      expect(joined.status).toBe(201);
      const agentToken = stringField(record(joined.body), "token");

      const posted = await send(baseUrl, "POST", `/rooms/${roomId}/posts`, agentToken, {
        text: "Ship the note today.",
      });
      expect(posted.status).toBe(201);
      expect(record(posted.body).outcome).toBe("accepted");

      const uploaded = await send(baseUrl, "POST", `/rooms/${roomId}/files`, agentToken, {
        filename: "agenda.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("ordinary hello").toString("base64"),
      });
      expect(uploaded.status).toBe(201);
      expect(record(uploaded.body).outcome).toBe("accepted");
      expect(db.prepare("SELECT COUNT(*) AS n FROM privacy_filters").get()).toEqual({ n: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("holds the item when the filter table cannot be read", () => {
    const db = openDatabase(":memory:");
    db.exec("DROP TABLE privacy_filters");
    const guard = createPrivacyGuard(db);
    const decision = guard.checkForOwner("O1", { kind: "message", text: "ordinary hello" });
    expect(decision.outcome).toBe("block");
    expect(JSON.stringify(decision)).not.toContain("ordinary hello");
    db.close();
  });
});

function roomIdOf(body: unknown): string {
  const room = record(record(body).room);
  if (typeof room.id !== "string") throw new Error("room id missing");
  return room.id;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`missing ${key}`);
  return field;
}
