import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../contract/index.js";
import { buildApp } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/index.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { guard } from "../../src/guard/index.js";
import { createOwnerNotifier } from "../../src/notices/index.js";
import { HOST_SECRET_HEADER, startHostListener } from "../../src/room/host.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

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

interface Hit {
  status: number;
  body: string;
  location: string | null;
  setCookies: string[];
}

function run(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: root, env: { ...process.env, ...env } },
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

function absorb(jar: Map<string, string>, setCookies: string[]): void {
  for (const header of setCookies) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function nonceOf(html: string): string {
  return /name="nonce" value="([^"]*)"/.exec(html)?.[1] ?? "";
}

async function call(
  base: string,
  method: string,
  urlPath: string,
  opts: { cookie?: string; form?: Record<string, string>; accept?: string; token?: string; json?: unknown } = {},
): Promise<Hit> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.accept) headers.accept = opts.accept;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const response = await fetch(`${base}${urlPath}`, { method, headers, body, redirect: "manual" });
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get("location"),
    setCookies: response.headers.getSetCookie(),
  };
}

describe("room:new", () => {
  const dirs: string[] = [];
  const previousOrigin = process.env.COMMONA_PUBLIC_ORIGIN;

  afterEach(async () => {
    if (previousOrigin === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previousOrigin;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "commona-room-new-"));
    dirs.push(dir);
    return dir;
  }

  async function startServer(): Promise<{
    base: string;
    host: string;
    secretPath: string;
    dbPath: string;
    stop: () => Promise<void>;
  }> {
    const dir = await tempDir();
    const dbPath = path.join(dir, "room.sqlite");
    const secretPath = path.join(dir, "host-secret");
    const db = openDatabase(dbPath);
    const deps = {
      db,
      clock: systemClock,
      tokens: createTokenStore(db),
      audit: createAuditLog(db, systemClock),
      sharing: createSharingDirectory(db),
      guard,
      notices: createOwnerNotifier(db, systemClock),
    };
    const app = buildApp(deps);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      await app.close();
      if (db.open) db.close();
      throw new Error("room server did not bind");
    }
    let host;
    try {
      host = await startHostListener(deps, { port: 0, secretPath });
    } catch (error) {
      await app.close();
      if (db.open) db.close();
      throw error;
    }
    return {
      base: `http://127.0.0.1:${address.port}`,
      host: host.url,
      secretPath,
      dbPath,
      stop: async () => {
        await host.close();
        await app.close();
        if (db.open) db.close();
      },
    };
  }

  function roomCount(dbPath: string): number {
    const db = openDatabase(dbPath);
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number }).n;
    } finally {
      if (db.open) db.close();
    }
  }

  async function postHost(
    host: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const response = await fetch(`${host}/host/room`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ title, hostName, inviteCount: 1 }),
    });
    return { status: response.status, body: await response.text() };
  }

  it("joins through an invite and the host credential file can post", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const dir = path.dirname(server.dbPath);
    const credentialPath = path.join(dir, "host-credential");
    try {
      const secret = await readFile(server.secretPath, "utf8");
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await stat(server.secretPath)).mode & 0o777).toBe(0o600);
      const result = await run([title, hostName, "2"], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET_FILE: server.secretPath,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const urls = urlsOf(result.stdout);
      expect(urls).toHaveLength(2);
      const credential = await readFile(credentialPath, "utf8");
      expect(credential.length).toBeGreaterThan(20);
      expect(credential).not.toContain(secret);
      expect(result.stdout).not.toContain(credential);
      expect(result.stderr).not.toContain(credential);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      const mode = (await stat(credentialPath)).mode & 0o777;
      expect(mode).toBe(0o600);

      const db = openDatabase(server.dbPath);
      try {
        const details = db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
        for (const row of details) {
          expect(row.detail_json).not.toContain(credential);
          expect(row.detail_json).not.toContain(secret);
        }
        const storedTitle = db.prepare("SELECT title FROM room_titles").get() as { title: string };
        expect(storedTitle.title).toBe(title);
        const room = db.prepare("SELECT id FROM rooms").get() as { id: string };

        const invitePath = new URL(urls[0] ?? "").pathname;
        const jar = new Map<string, string>();
        const welcome = await call(server.base, "GET", invitePath, { accept: "text/html" });
        expect(welcome.status).toBe(200);
        expect(welcome.body).toContain(`${hostName} invited you to ${title}.`);
        expect(welcome.body).toContain("<button type=\"submit\">Join</button>");
        absorb(jar, welcome.setCookies);
        expect(jar.get("commona_invite") ?? "").not.toBe("");

        const named = await call(server.base, "POST", `${invitePath}/continue`, {
          cookie: cookieHeader(jar),
          form: { nonce: nonceOf(welcome.body), firstName: "Demo" },
        });
        expect(named.status).toBe(303);
        const sharing = await call(server.base, "GET", `${invitePath}/sharing`, {
          accept: "text/html",
          cookie: cookieHeader(jar),
        });
        expect(sharing.status).toBe(200);
        absorb(jar, sharing.setCookies);
        const finished = await call(server.base, "POST", `${invitePath}/finish`, {
          cookie: cookieHeader(jar),
          form: { nonce: nonceOf(sharing.body), seeing: "Messages" },
        });
        expect(finished.status).toBe(303);
        expect(finished.location).toBe(`${invitePath}/done`);
        absorb(jar, finished.setCookies);
        const done = await call(server.base, "GET", `${invitePath}/done`, {
          accept: "text/html",
          cookie: cookieHeader(jar),
        });
        expect(done.status).toBe(200);
        expect(done.body).toContain("You're in.");
        const members = db.prepare("SELECT COUNT(*) AS n FROM memberships").get() as { n: number };
        expect(members.n).toBe(2);

        const posted = await call(server.base, "POST", `/rooms/${room.id}/posts`, {
          token: credential,
          json: { text: "host says hello" },
        });
        expect(posted.status).toBe(201);
        expect((JSON.parse(posted.body) as { outcome?: string }).outcome).toBe("accepted");
        expect(posted.body).not.toContain(credential);
      } finally {
        if (db.open) db.close();
      }
    } finally {
      await server.stop();
    }
  });

  it("defaults to two invite URLs", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const credentialPath = path.join(path.dirname(server.dbPath), "host-credential");
    try {
      const result = await run([title, hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET_FILE: server.secretPath,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(urlsOf(result.stdout)).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("stops when the origin is not https and prints no link", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = "http://join.example.test";
    const server = await startServer();
    const credentialPath = path.join(path.dirname(server.dbPath), "host-credential");
    try {
      const result = await run([title, hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET_FILE: server.secretPath,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("COMMONA_PUBLIC_ORIGIN must be an https origin\n");
      expect(result.stderr).not.toContain("http://join.example.test");
    } finally {
      await server.stop();
    }
  });

  it("does not serve the host command on the public port", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    try {
      const secret = await readFile(server.secretPath, "utf8");
      const response = await fetch(`${server.base}/host/room`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HOST_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ title, hostName, inviteCount: 1 }),
      });
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(secret);
      expect(body).not.toContain("inv_");
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("refuses a forwarded header and a wrong or missing secret", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    try {
      const secret = await readFile(server.secretPath, "utf8");
      const forwarded = ["cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip"];
      for (const name of forwarded) {
        const hit = await postHost(server.host, {
          [HOST_SECRET_HEADER]: secret,
          [name]: "127.0.0.1",
        });
        expect(hit.status).toBe(403);
        expect(hit.body).not.toContain(secret);
        expect(hit.body).not.toContain("inv_");
      }
      const missing = await postHost(server.host, {});
      expect(missing.status).toBe(403);
      expect(missing.body).not.toContain("inv_");
      const wrong = await postHost(server.host, { [HOST_SECRET_HEADER]: "a".repeat(43) });
      expect(wrong.status).toBe(403);
      expect(wrong.body).not.toContain(secret);
      expect(wrong.body).not.toContain("inv_");
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
