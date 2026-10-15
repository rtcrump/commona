import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { loadFixtures, seedFixtures } from "./helpers/fixtures.js";

const exec = promisify(execFile);

describe("fixtures", () => {
  it("loads the synthetic pack and seeds owners and agents", () => {
    const pack = loadFixtures();
    expect(pack.owners.map((owner) => owner.email)).toEqual([
      "o1@example.test",
      "o2@example.test",
      "o3@example.test",
    ]);
    expect(pack.normalMessages).toHaveLength(20);
    const db = openDatabase(":memory:");
    seedFixtures(db, pack);
    const agents = db.prepare("SELECT id, owner_id, webhook_url FROM agents ORDER BY id").all() as {
      id: string;
      owner_id: string;
      webhook_url: string;
    }[];
    expect(agents.map((agent) => agent.id)).toEqual(["A1", "A2", "AX"]);
    expect(agents.every((agent) => agent.webhook_url.includes("127.0.0.1"))).toBe(true);
    const filters = db
      .prepare(
        "SELECT owner_id, terms_json, patterns_json, presets_json FROM privacy_filters ORDER BY owner_id",
      )
      .all() as { owner_id: string; terms_json: string; patterns_json: string; presets_json: string }[];
    expect(filters.map((row) => row.owner_id)).toEqual(["O1", "O2", "O3"]);
    for (const row of filters) {
      expect(JSON.parse(row.terms_json)).toEqual([]);
      expect(JSON.parse(row.patterns_json)).toEqual(["health_number", "dob"]);
      expect(JSON.parse(row.presets_json)).toEqual(["clarity-demo"]);
    }
    db.close();
  });

  // The script spawns a process per path. On Windows that exceeds the default 5s.
  it("keeps the invented patient markers inside fixtures and test", async () => {
    const { stdout } = await exec("bash", ["scripts/check-fake-data.sh"]);
    expect(stdout).toContain("fake-data check ok");
  }, 30_000);

  it("keeps the acceptance harness on npm run m1", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { m1: string; test: string } };
    expect(pkg.scripts.m1).toBe("tsx scripts/m1.ts");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.test).not.toContain("m1");
  });
});
