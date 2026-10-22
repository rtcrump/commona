import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken, systemClock, type ContentGuard } from "../../contract/index.js";
import { buildApp } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/index.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { createOwnerNotifier } from "../../src/notices/index.js";
import type { RoomDeps } from "../../src/room/deps.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";
import { createSharingDirectory } from "../../src/sharing/index.js";

const allowAll: ContentGuard = {
  check() {
    return { outcome: "allow", hits: [] };
  },
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "scripts/room-new.ts");
const origin = "https://join.example.test";
const hostSecret = "host-test-secret";
const title = "Sunday lunch";
const hostName = "Host (demo)";
const inviteUrl = new RegExp(
  `^${origin}/j/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]+$`,
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
  const previousSecret = process.env.COMMONA_HOST_SECRET;

  afterEach(async () => {
    if (previousOrigin === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previousOrigin;
    if (previousSecret === undefined) delete process.env.COMMONA_HOST_SECRET;
    else process.env.COMMONA_HOST_SECRET = previousSecret;
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
    deps: RoomDeps;
    stop: () => Promise<void>;
  }> {
    const dir = await tempDir();
    const dbPath = path.join(dir, "room.sqlite");
    const secretPath = path.join(dir, "host-secret");
    process.env.COMMONA_HOST_SECRET = hostSecret;
    const db = openDatabase(dbPath);
    const deps = {
      db,
      clock: systemClock,
      tokens: createTokenStore(db),
      audit: createAuditLog(db, systemClock),
      sharing: createSharingDirectory(db),
      guard: allowAll,
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
    const base = `http://127.0.0.1:${address.port}`;
    return {
      base,
      host: base,
      secretPath,
      dbPath,
      deps,
      stop: async () => {
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

  function fieldsOf(text: string): {
    token: string;
    roomId: string;
    agentId: string;
    ownerToken: string;
    ownerId: string;
  } {
    const fields = new Map<string, string>();
    for (const line of text.trim().split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return {
      token: fields.get("COMMONA_AGENT_TOKEN") ?? "",
      roomId: fields.get("COMMONA_ROOM_ID") ?? "",
      agentId: fields.get("COMMONA_AGENT_ID") ?? "",
      ownerToken: fields.get("COMMONA_OWNER_TOKEN") ?? "",
      ownerId: fields.get("COMMONA_OWNER_ID") ?? "",
    };
  }

  it("joins through an invite, the host can post, and the invitee can read it", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const dir = path.dirname(server.dbPath);
    const credentialPath = path.join(dir, "host-credential");
    try {
      const result = await run([title, hostName, "2"], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const urls = urlsOf(result.stdout);
      expect(urls).toHaveLength(2);
      const credentialFile = await readFile(credentialPath, "utf8");
      const fields = fieldsOf(credentialFile);
      expect(fields.token.length).toBeGreaterThan(20);
      expect(fields.roomId).toMatch(/^room_[0-9a-f-]{36}$/);
      expect(fields.agentId).toMatch(/^agent_[0-9a-f-]{36}$/);
      expect(fields.ownerToken.length).toBeGreaterThan(20);
      expect(fields.ownerId).toMatch(/^owner_[0-9a-f-]{36}$/);
      expect(fields.ownerToken).not.toBe(fields.token);
      expect(credentialFile).toBe(
        `COMMONA_AGENT_TOKEN=${fields.token}\nCOMMONA_ROOM_ID=${fields.roomId}\nCOMMONA_AGENT_ID=${fields.agentId}\nCOMMONA_OWNER_TOKEN=${fields.ownerToken}\nCOMMONA_OWNER_ID=${fields.ownerId}\n`,
      );
      expect(credentialFile).not.toContain(hostSecret);
      for (const hidden of [
        fields.token,
        fields.roomId,
        fields.agentId,
        fields.ownerToken,
        fields.ownerId,
        hostSecret,
      ]) {
        expect(result.stdout).not.toContain(hidden);
        expect(result.stderr).not.toContain(hidden);
      }
      const mode = (await stat(credentialPath)).mode & 0o777;
      expect(mode).toBe(0o600);

      const db = openDatabase(server.dbPath);
      try {
        const details = db.prepare("SELECT detail_json FROM audit_log").all() as { detail_json: string }[];
        for (const row of details) {
          expect(row.detail_json).not.toContain(fields.token);
          expect(row.detail_json).not.toContain(fields.ownerToken);
          expect(row.detail_json).not.toContain(hostSecret);
        }
        const owner = db.prepare("SELECT token_hash FROM owners WHERE id = ?").get(fields.ownerId) as {
          token_hash: string;
        };
        expect(owner.token_hash).toBe(hashToken(fields.ownerToken));
        expect(owner.token_hash).not.toContain(fields.ownerToken);
        const issued = db
          .prepare("SELECT result, owner_id, agent_id, detail_json FROM audit_log WHERE action = 'setting_change'")
          .all() as { result: string; owner_id: string; agent_id: string; detail_json: string }[];
        expect(
          issued.some(
            (row) =>
              row.result === "ok" &&
              row.owner_id === fields.ownerId &&
              row.agent_id === `owner:${fields.ownerId}` &&
              row.detail_json === `{"itemId":"${fields.ownerId}"}`,
          ),
        ).toBe(true);
        expect(fields.roomId).toBe((db.prepare("SELECT id FROM rooms").get() as { id: string }).id);
        const storedTitle = db.prepare("SELECT title FROM room_titles").get() as { title: string };
        expect(storedTitle.title).toBe(title);
        const room = db.prepare("SELECT id FROM rooms").get() as { id: string };

        const openPath = new URL(urls[0] ?? "").pathname;
        const inviteId = openPath.split("/")[2] ?? "";
        const invitePath = `/j/${inviteId}`;
        const jar = new Map<string, string>();
        const welcome = await call(server.base, "GET", openPath, { accept: "text/html" });
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
          token: fields.token,
          json: { text: "host says hello" },
        });
        expect(posted.status).toBe(201);
        expect((JSON.parse(posted.body) as { outcome?: string }).outcome).toBe("accepted");
        expect(posted.body).not.toContain(fields.token);

        const hostOwner = db
          .prepare("SELECT owner_id AS ownerId FROM memberships WHERE room_id = ? AND agent_id = ?")
          .get(room.id, fields.agentId) as { ownerId: string };
        const invitee = db
          .prepare(
            "SELECT agent_id AS agentId, owner_id AS ownerId FROM memberships WHERE room_id = ? AND agent_id <> ?",
          )
          .get(room.id, fields.agentId) as { agentId: string; ownerId: string };
        const granted = db
          .prepare("SELECT level FROM sharing WHERE room_id = ? AND from_owner_id = ? AND to_owner_id = ?")
          .get(room.id, hostOwner.ownerId, invitee.ownerId) as { level: string };
        expect(granted.level).toBe("messages");
        const inviteeToken = server.deps.tokens.issueAgentToken(invitee.agentId);
        const feed = await call(server.base, "GET", `/rooms/${room.id}/feed`, { token: inviteeToken });
        expect(feed.status).toBe(200);
        const items = (JSON.parse(feed.body) as { items?: { text?: string }[] }).items ?? [];
        expect(items.some((item) => item.text === "host says hello")).toBe(true);
        expect(feed.body).not.toContain(fields.token);
        expect(feed.body).not.toContain(hostSecret);
        expect(feed.body).not.toContain(inviteeToken);
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
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(urlsOf(result.stdout)).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("accepts a room title without content filtering", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const credentialPath = path.join(path.dirname(server.dbPath), "host-credential");
    try {
      const result = await run(["Jane Testpatient", hostName, "1"], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(urlsOf(result.stdout)).toHaveLength(1);
      const db = openDatabase(server.dbPath);
      try {
        const stored = db.prepare("SELECT title FROM room_titles").get() as { title: string };
        expect(stored.title).toBe("Jane Testpatient");
      } finally {
        if (db.open) db.close();
      }
    } finally {
      await server.stop();
    }
  });

  it("rejects a title with an angle bracket and creates nothing", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const credentialPath = path.join(path.dirname(server.dbPath), "host-credential");
    try {
      const result = await run(["Sunday <lunch>", hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("room title must be a short label\n");
      expect(roomCount(server.dbPath)).toBe(0);
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
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("COMMONA_PUBLIC_ORIGIN must be an https origin\n");
      expect(result.stderr).not.toContain("http://join.example.test");
    } finally {
      await server.stop();
    }
  });

  it("refuses room creation on the public route without the host secret", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    try {
      const response = await fetch(`${server.base}/host/room`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, hostName, inviteCount: 1 }),
      });
      const body = await response.text();
      expect(response.status).toBe(403);
      expect(body).not.toContain(hostSecret);
      expect(body).not.toContain("inv_");
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("ignores forwarded headers and still refuses a wrong or missing secret", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    try {
      const missing = await postHost(server.host, {});
      expect(missing.status).toBe(403);
      expect(missing.body).not.toContain("inv_");
      const wrong = await postHost(server.host, { [HOST_SECRET_HEADER]: "wrong-host-secret" });
      expect(wrong.status).toBe(403);
      expect(wrong.body).not.toContain(hostSecret);
      expect(wrong.body).not.toContain("inv_");
      expect(roomCount(server.dbPath)).toBe(0);
      const forwarded = ["cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip"];
      for (const name of forwarded) {
        const hit = await postHost(server.host, {
          [HOST_SECRET_HEADER]: hostSecret,
          [name]: "203.0.113.4",
        });
        expect(hit.status).toBe(201);
        expect(hit.body).not.toContain(hostSecret);
      }
    } finally {
      await server.stop();
    }
  });

  it("creates nothing when the credential file cannot be written", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const dir = path.dirname(server.dbPath);
    try {
      const missing = await run([title, hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: path.join(dir, "missing-dir", "host-credential"),
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(missing.code).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toBe("COMMONA_HOST_CREDENTIAL is not writable\n");

      const existing = path.join(dir, "host-credential");
      await writeFile(existing, "keep\n");
      const blocked = await run([title, hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: existing,
        COMMONA_HOST_SECRET: hostSecret,
      });
      expect(blocked.code).toBe(1);
      expect(blocked.stdout).toBe("");
      expect(blocked.stderr).toBe("COMMONA_HOST_CREDENTIAL is not writable\n");
      expect(await readFile(existing, "utf8")).toBe("keep\n");
      expect(blocked.stderr).not.toContain(hostSecret);
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("does not write a host secret file", async () => {
    const server = await startServer();
    try {
      await expect(stat(server.secretPath)).rejects.toThrow();
      const missing = await postHost(server.base, {});
      expect(missing.status).toBe(403);
      expect(missing.body).not.toContain(hostSecret);
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("stops when the host secret is not set and creates nothing", async () => {
    process.env.COMMONA_PUBLIC_ORIGIN = origin;
    const server = await startServer();
    const credentialPath = path.join(path.dirname(server.dbPath), "host-credential");
    try {
      const result = await run([title, hostName], {
        COMMONA_URL: server.host,
        COMMONA_HOST_CREDENTIAL: credentialPath,
        COMMONA_HOST_SECRET: "",
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("COMMONA_HOST_SECRET is not set\n");
      expect(roomCount(server.dbPath)).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
