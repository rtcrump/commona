import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { listenDemo, type DemoListener } from "../../src/demo/node-listen.js";
import { DEMO_LABEL, DEMO_MESSAGES } from "../../src/demo/transcript.js";

const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];

describe("public demo in a clean browser", () => {
  let server: DemoListener;
  let browser: Browser;

  beforeAll(async () => {
    server = await listenDemo();
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows both owners, both approvals, and both reports on a desktop within 30 seconds", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
    try {
      await expectCleanStory(context, server.origin, false);
    } finally {
      await context.close();
    }
  });

  it("shows the same finished story on a phone with reduced motion", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    try {
      await expectCleanStory(context, server.origin, true);
    } finally {
      await context.close();
    }
  });

  it("shows the whole story with JavaScript off", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: false,
    });
    try {
      const page = await context.newPage();
      await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
      const pageText = await page.locator("body").innerText();
      const story = await page.locator("#transcript").innerText();
      expect(pageText).toContain(DEMO_LABEL);
      expect(story).toContain("Nia approves sharing messages with Sol.");
      expect(story).toContain("Sol approves sharing messages with Nia.");
      expect(story).toContain(DEMO_MESSAGES.reportToNia);
      expect(story).toContain(DEMO_MESSAGES.reportToSol);
      expect(story).toContain("The walk is agreed.");
      expect(await context.cookies()).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

async function expectCleanStory(context: BrowserContext, origin: string, reducedMotion: boolean): Promise<void> {
  expect(await context.cookies()).toEqual([]);
  const page = await context.newPage();
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const started = Date.now();
  await page.goto(`${origin}/?invite=CANARY-QUERY`, { waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).search).toBe("");
  expect(page.url()).not.toContain("CANARY-QUERY");
  const pageText = await page.locator("body").innerText();
  const story = await page.locator("#transcript").innerText();
  expect(pageText).toContain(DEMO_LABEL);
  expect(pageText).toContain("No model is answering");
  expect(story).toContain("Nia");
  expect(story).toContain("Sol");
  expect(story).toContain("Lark");
  expect(story).toContain("Reed");
  expect(story).toContain("Nia approves sharing messages with Sol.");
  expect(story).toContain("Sol approves sharing messages with Nia.");
  expect(story).toContain(DEMO_MESSAGES.larkOffer);
  expect(story).toContain(DEMO_MESSAGES.reedOffer);
  expect(story).toContain("The walk is agreed.");
  expect(story).toContain(DEMO_MESSAGES.reportToNia);
  expect(story).toContain(DEMO_MESSAGES.reportToSol);
  const timeout = reducedMotion ? 5_000 : 25_000;
  await page.waitForSelector('[data-demo-replay][data-state="done"]', { timeout });
  expect(Date.now() - started).toBeLessThanOrEqual(30_000);
  const stored = await page.evaluate(() => {
    const view = globalThis as unknown as {
      document: { cookie: string };
      localStorage: { length: number };
      sessionStorage: { length: number };
    };
    return {
      cookie: view.document.cookie,
      local: view.localStorage.length,
      session: view.sessionStorage.length,
    };
  });
  expect(stored).toEqual({ cookie: "", local: 0, session: 0 });
  expect(await context.cookies()).toEqual([]);
  for (const url of requested) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(origin);
    if (parsed.pathname !== "/") expect(parsed.search).toBe("");
    expect(url).not.toContain(DEMO_MESSAGES.larkOffer);
    expect(url).not.toContain("cloudflareinsights");
  }
  expect(requested.some((url) => new URL(url).pathname === "/" && new URL(url).search === "")).toBe(true);
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("/host/room", { method: "POST", body: "{}" });
      return "allowed";
    } catch {
      return "blocked";
    }
  });
  expect(blocked).toBe("blocked");
  const hostile = await context.request.post(`${origin}/host/room`, {
    data: JSON.stringify({ title: "CANARY-HOST" }),
    headers: { "content-type": "application/json" },
  });
  expect(hostile.status()).toBe(404);
  const hostileText = await hostile.text();
  expect(hostileText).not.toContain("CANARY-HOST");
  expect(hostileText).not.toContain(DEMO_MESSAGES.agreement);
  expect(hostile.headers()["set-cookie"] ?? "").toBe("");
  await page.locator("[data-demo-play]").focus();
  expect(await page.locator("[data-demo-play]").evaluate((node) => node.tagName)).toBe("BUTTON");
}

async function launch(): Promise<Browser> {
  const options = { headless: true, args: LAUNCH_ARGS };
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch {
    return await chromium.launch(options);
  }
}
