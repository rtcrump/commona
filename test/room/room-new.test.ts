import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "scripts/room-new.ts");
const origin = "https://join.example.test";
const title = "Sunday lunch";
const hostName = "Host (demo)";
const inviteUrl = new RegExp(
  `^${origin}/j/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      {
        cwd: root,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function urlsOf(stdout: string): string[] {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.slice(0, -1).split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => inviteUrl.test(line))).toBe(true);
  expect(stdout).toBe(`${lines.join("\n")}\n`);
  return lines;
}

describe("room:new", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDb(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "commona-room-new-"));
    dirs.push(dir);
    return path.join(dir, "room.sqlite");
  }

  it("prints only invite URLs and those URLs open the join page", async () => {
    const dbPath = await tempDb();
    const result = await run([title, hostName, "2"], {
      COMMONA_DB: dbPath,
      COMMONA_PUBLIC_ORIGIN: origin,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const urls = urlsOf(result.stdout);
    expect(urls).toHaveLength(2);
    expect(result.stdout).not.toMatch(/token|secret|credential|bearer|password/i);

    const db = openDatabase(dbPath);
    const app = buildApp({ db });
    try {
      const details = db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
      expect(details.length).toBeGreaterThan(0);
      for (const row of details) {
        expect(row.detail_json).not.toMatch(/token|secret|credential|bearer|password/i);
      }
      const storedTitle = db.prepare("SELECT title FROM room_titles").get() as { title: string };
      expect(storedTitle.title).toBe(title);
      const host = db.prepare("SELECT display_name FROM owners").get() as { display_name: string };
      expect(host.display_name).toBe(hostName);
      const members = db.prepare("SELECT COUNT(*) AS n FROM memberships").get() as { n: number };
      expect(members.n).toBe(1);
      const room = db.prepare("SELECT id FROM rooms").get() as { id: string };

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("room server did not bind");
      const base = `http://127.0.0.1:${address.port}`;
      for (const url of urls) {
        const page = await fetch(`${base}${new URL(url).pathname}`, { headers: { accept: "text/html" } });
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type") ?? "").toContain("text/html");
        const html = await page.text();
        expect(html).toContain(`${hostName} invited you to ${title}.`);
        expect(html).toContain("<button type=\"submit\">Join</button>");
        expect(html).not.toContain(room.id);
        expect(html).not.toContain("can't be used");
      }
    } finally {
      await app.close();
      if (db.open) db.close();
    }
  });

  it("defaults to two invite URLs", async () => {
    const dbPath = await tempDb();
    const result = await run([title, hostName], {
      COMMONA_DB: dbPath,
      COMMONA_PUBLIC_ORIGIN: origin,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(urlsOf(result.stdout)).toHaveLength(2);
  });

  it("stops when the origin is not https and prints no link", async () => {
    const dbPath = await tempDb();
    const result = await run([title, hostName], {
      COMMONA_DB: dbPath,
      COMMONA_PUBLIC_ORIGIN: "http://join.example.test",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("COMMONA_PUBLIC_ORIGIN must be an https origin\n");
    expect(result.stderr).not.toContain("http://join.example.test");
  });
});
