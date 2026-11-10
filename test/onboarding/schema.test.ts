import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db.js";

describe("built invite schema", () => {
  it("embeds the migration SQL in dist", async () => {
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });
    const js = readFileSync("dist/src/join/schema.js", "utf8");
    expect(js).not.toContain("001_invites.sql");
    expect(js).not.toContain("readFileSync");
    const built = (await import(pathToFileURL(path.resolve("dist/src/join/schema.js")).href)) as {
      INVITE_SCHEMA_SQL: string;
      ensureInviteSchema: (db: ReturnType<typeof openDatabase>) => void;
    };
    expect(built.INVITE_SCHEMA_SQL.length).toBeGreaterThan(0);
    expect(built.INVITE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS invites");
    const db = openDatabase(":memory:");
    try {
      built.ensureInviteSchema(db);
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('invites', 'owner_agents', 'agent_handoffs') ORDER BY name",
        )
        .all() as { name: string }[];
      expect(names.map((row) => row.name)).toEqual(["agent_handoffs", "invites", "owner_agents"]);
    } finally {
      db.close();
    }
  });
});
