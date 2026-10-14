import { execFile } from "node:child_process";
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
    db.close();
  });

  it("keeps the invented patient markers inside fixtures and test", async () => {
    const { stdout } = await exec("bash", ["scripts/check-fake-data.sh"]);
    expect(stdout).toContain("fake-data check ok");
  });

  it("does not claim the acceptance run has passed", async () => {
    const { stdout } = await exec("node", ["--import", "tsx", "scripts/m1-placeholder.ts"]);
    expect(stdout).toContain("placeholder");
    expect(stdout).toContain("not run");
  });
});
