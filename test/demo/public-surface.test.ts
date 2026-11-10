import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HEALTH_NUMBER_PATTERN } from "../../contract/index.js";
import { guard } from "../../src/guard/index.js";
import {
  BEACON_CONNECT,
  BEACON_SRC,
  beaconMarkup,
  beaconPayload,
  contentSecurityPolicy,
} from "../../src/demo/analytics.js";
import { handleDemoRequest } from "../../src/demo/handler.js";
import {
  DEMO_LABEL,
  DEMO_MESSAGES,
  STORY_DURATION_MS,
  STORY_STEPS,
  storySentences,
} from "../../src/demo/transcript.js";
import { loadFixtures } from "../helpers/fixtures.js";
import { assertStyles } from "../onboarding/a11y.js";

const root = path.resolve(import.meta.dirname, "../..");
const TOKEN = "demoAnalyticsToken01";

const HOSTILE_PATHS = [
  "/rooms",
  "/rooms/room_canary",
  "/api/r/room_canary",
  "/api/rooms/room_canary/sharing",
  "/r/room_canary",
  "/j/inv_canary/secret_canary",
  "/host/room",
  "/log",
  "/notices",
  "/join",
];

describe("public demo surface", () => {
  it("labels the story and keeps the private worker entry", async () => {
    const home = await text(await handleDemoRequest(new Request("https://demo.example.test/")));
    const alias = await text(await handleDemoRequest(new Request("https://demo.example.test/demo")));
    expect(home.status).toBe(200);
    expect(alias.body).toBe(home.body);
    expect(home.body).toContain(DEMO_LABEL);
    expect(home.body).toContain("No model is answering");
    expect(decode(home.body)).toContain(DEMO_MESSAGES.larkOffer);
    expect(decode(home.body)).toContain(DEMO_MESSAGES.reedOffer);
    expect(decode(home.body)).toContain(DEMO_MESSAGES.agreement);
    expect(decode(home.body)).toContain(DEMO_MESSAGES.reportToNia);
    expect(decode(home.body)).toContain(DEMO_MESSAGES.reportToSol);
    expect(home.body).toContain("Nia approves sharing messages with Sol.");
    expect(home.body).toContain("Sol approves sharing messages with Nia.");
    expect(home.body).toContain("Lark reports to Nia");
    expect(home.body).toContain("Reed reports to Sol");
    expect(home.body).toContain("The walk is agreed.");
    expect(home.body).toContain('lang="en"');
    expect(home.body.match(/<h1\b/g)).toHaveLength(1);
    expect(home.body).not.toMatch(/<form[\s>]/i);
    expect(home.body).not.toMatch(/<input[\s>]/i);
    expect(home.body).not.toMatch(/<textarea[\s>]/i);
    expect(home.body).toContain('href="/demo/demo.css"');
    expect(home.body).toContain('src="/demo/replay.js"');
    expect(home.body).toContain("Page analytics is not loaded.");
    expect(home.body).not.toContain("cloudflareinsights");
    expect(home.headers.get("set-cookie")).toBeNull();
    expect(home.headers.get("referrer-policy")).toBe("no-referrer");
    expect(home.headers.get("content-security-policy")).toBe(contentSecurityPolicy(false));
    expect(home.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(STORY_DURATION_MS).toBeLessThanOrEqual(20_000);
    expect(STORY_STEPS[STORY_STEPS.length - 1]?.atMs).toBe(STORY_DURATION_MS);

    const toml = readFileSync(path.join(root, "wrangler.toml"), "utf8");
    expect(toml).toContain('main = "src/worker.ts"');
    expect(toml).toContain('name = "DIRECTORY"');
    expect(toml).toContain('class_name = "DirectoryObject"');
  });

  it("serves the stylesheet, the replay, and a demo health check", async () => {
    const css = await text(await handleDemoRequest(new Request("https://demo.example.test/demo/demo.css")));
    const script = await text(await handleDemoRequest(new Request("https://demo.example.test/demo/replay.js")));
    const health = await text(await handleDemoRequest(new Request("https://demo.example.test/health")));
    const demoHealth = await text(await handleDemoRequest(new Request("https://demo.example.test/demo/health")));
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(script.headers.get("content-type")).toContain("javascript");
    assertStyles(css.body);
    expect(css.body).toBe(readFileSync(path.join(root, "web/demo/demo.css"), "utf8"));
    expect(script.body).toBe(readFileSync(path.join(root, "web/demo/replay.txt"), "utf8"));
    expect(script.body).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|cookie/);
    expect(script.body).not.toMatch(/location|searchParams|\.search/);
    expect(css.body).not.toMatch(/https?:|url\(/i);
    expect(script.body).not.toContain("cloudflareinsights");
    expect(health.body).toBe('{"ok":true,"service":"commona-demo"}');
    expect(demoHealth.body).toBe(health.body);
    expect(health.body).not.toBe('{"ok":true,"service":"commona"}');
  });

  it("strips query strings and refuses writes without echoing them", async () => {
    const dirty = await handleDemoRequest(new Request("https://demo.example.test/?invite=CANARY-QUERY"));
    expect(dirty.status).toBe(302);
    expect(dirty.headers.get("location")).toBe("/");
    expect(dirty.headers.get("location")).not.toContain("?");
    expect(dirty.headers.get("set-cookie")).toBeNull();
    expect(await dirty.text()).not.toContain("CANARY-QUERY");

    const slash = await handleDemoRequest(new Request("https://demo.example.test/demo/?x=1"));
    expect(slash.status).toBe(302);
    expect(slash.headers.get("location")).toBe("/demo");

    const posted = await text(
      await handleDemoRequest(
        new Request("https://demo.example.test/", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer CANARY-SECRET" },
          body: JSON.stringify({ text: "CANARY-BODY", invite: "CANARY-SECRET" }),
        }),
      ),
    );
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    expect(posted.body).not.toContain("CANARY-BODY");
    expect(posted.body).not.toContain("CANARY-SECRET");
    expect(posted.body).not.toContain(DEMO_MESSAGES.larkOffer);

    const head = await handleDemoRequest(new Request("https://demo.example.test/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(head.headers.get("set-cookie")).toBeNull();
  });

  it("keeps hostile paths away from the story and from private data", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const pathName of HOSTILE_PATHS) {
        const response = await text(
          await handleDemoRequest(
            new Request(`https://demo.example.test${pathName}`, {
              method,
              headers: { cookie: "commona_session=CANARY-COOKIE", authorization: "Bearer CANARY-SECRET" },
              body: method === "GET" ? undefined : "CANARY-BODY",
            }),
          ),
        );
        expect(response.status, `${method} ${pathName}`).toBe(404);
        expect(response.body).not.toContain("CANARY");
        expect(response.body).not.toContain(DEMO_MESSAGES.agreement);
        expect(response.body).not.toContain("ownerToken");
        expect(response.body).not.toContain("DIRECTORY");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.body).toContain(DEMO_LABEL);
      }
    }
  });

  it("loads analytics only on fixed pages when a site token is configured", async () => {
    const env = { COMMONA_DEMO_ANALYTICS_TOKEN: TOKEN };
    const home = await text(await handleDemoRequest(new Request("https://demo.example.test/"), env));
    const privacy = await text(await handleDemoRequest(new Request("https://demo.example.test/demo/privacy"), env));
    const css = await text(await handleDemoRequest(new Request("https://demo.example.test/demo/demo.css"), env));
    const health = await text(await handleDemoRequest(new Request("https://demo.example.test/health"), env));
    const dirty = await handleDemoRequest(new Request("https://demo.example.test/demo/privacy?q=secret"), env);
    expect(home.body).toContain(BEACON_SRC);
    expect(home.body).toContain("Page analytics is on");
    expect(privacy.body).toContain(BEACON_SRC);
    expect(visible(home.body)).not.toContain(TOKEN);
    expect(visible(privacy.body)).not.toContain(TOKEN);
    expect(css.body).not.toContain(BEACON_SRC);
    expect(health.body).not.toContain(TOKEN);
    expect(dirty.status).toBe(302);
    expect(await dirty.text()).not.toContain(TOKEN);
    expect(home.headers.get("content-security-policy")).toContain(BEACON_SRC);
    expect(home.headers.get("content-security-policy")).toContain(BEACON_CONNECT);
    expect(css.headers.get("content-security-policy")).not.toContain(BEACON_SRC);

    const payload = beaconAttribute(home.body);
    expect(payload).toEqual(beaconPayload(TOKEN));
    expect(JSON.stringify(payload)).not.toContain(DEMO_MESSAGES.larkOffer);

    for (const bad of ["zz", "has space token!!", "<script>", `${TOKEN}&q=1`]) {
      const response = await text(
        await handleDemoRequest(new Request("https://demo.example.test/"), {
          COMMONA_DEMO_ANALYTICS_TOKEN: bad,
        }),
      );
      expect(response.body).not.toContain("cloudflareinsights");
      expect(response.body).not.toContain(bad);
    }
    const blank = await text(
      await handleDemoRequest(new Request("https://demo.example.test/"), { COMMONA_DEMO_ANALYTICS_TOKEN: "" }),
    );
    expect(blank.body).not.toContain("cloudflareinsights");
    expect(beaconMarkup(TOKEN)).toBe(
      `<script defer src="${BEACON_SRC}" data-cf-beacon="${JSON.stringify(beaconPayload(TOKEN)).replaceAll('"', "&quot;")}"></script>`,
    );
  });

  it("uses fictional copy the name guard allows", () => {
    const pack = loadFixtures();
    const listed = (pack.names[0] ?? "").toLowerCase();
    const health = pack.notesWithPatient.match(new RegExp(HEALTH_NUMBER_PATTERN))?.[0] ?? "";
    expect(listed.length).toBeGreaterThan(0);
    expect(health.length).toBeGreaterThan(0);
    const files = sourceFiles();
    const blob = files.map((file) => readFileSync(file, "utf8")).join("\n").toLowerCase();
    expect(blob).not.toContain(listed);
    if (health) expect(blob).not.toContain(health.toLowerCase());
    for (const phrase of blockedPhrases()) expect(blob).not.toContain(phrase);
    for (const sentence of storySentences()) {
      expect(guard.check({ kind: "message", text: sentence })).toEqual({ outcome: "allow", hits: [] });
      expect(sentence.toLowerCase()).not.toContain(listed);
    }
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from ["'](?:\.\.\/)+(?:app|worker|runtime|room|host|auth|sharing|audit|db)(?:\/|["'])/);
      expect(source, file).not.toContain("better-sqlite3");
      expect(source, file).not.toContain("COMMONA_HOST_SECRET");
      expect(source, file).not.toContain("DIRECTORY");
    }
  });
});

function blockedPhrases(): string[] {
  return [["traf", "fordcrump"].join(""), ["clar", "ity"].join(""), ["int", "ake"].join(""), ["agent", " room"].join("")];
}

function sourceFiles(): string[] {
  const found: string[] = [];
  walk(path.join(root, "src/demo"), found);
  walk(path.join(root, "web/demo"), found);
  found.push(path.join(root, "scripts/demo-public.ts"));
  return found.filter((file) => !file.endsWith(".d.ts"));
}

function walk(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
}

function decode(html: string): string {
  return html
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function visible(html: string): string {
  return decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
}

function beaconAttribute(html: string): unknown {
  const match = /data-cf-beacon="([^"]+)"/.exec(html);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse((match?.[1] ?? "").replaceAll("&quot;", '"')) as unknown;
}

async function text(response: Response): Promise<{ status: number; body: string; headers: Headers }> {
  return { status: response.status, body: await response.text(), headers: response.headers };
}
