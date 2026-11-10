import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleDemoRequest } from "../../src/demo/handler.js";
import { DEMO_LABEL, DEMO_MESSAGES } from "../../src/demo/transcript.js";
import "../../src/demo/worker.js";

describe("public demo inside the worker runtime", () => {
  it("serves the labelled story with no cookie", async () => {
    const response = await handleDemoRequest(new Request("https://demo.example.test/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(DEMO_LABEL);
    expect(html).toContain("Lark reports to Nia");
    expect(html).toContain("Reed reports to Sol");
    expect(html).toContain("Nothing is still open.");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).not.toContain("DIRECTORY");
  });

  it("does not echo a private-looking path", async () => {
    const response = await handleDemoRequest(new Request("https://demo.example.test/rooms/CANARY-ROOM"), {});
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("CANARY-ROOM");
  });

  it("leaves the private worker on its own entry", async () => {
    const health = await SELF.fetch("https://room.example.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "commona" });
    const root = await SELF.fetch("https://room.example.test/");
    const body = await root.text();
    expect(body).not.toContain(DEMO_LABEL);
    expect(body).not.toContain(DEMO_MESSAGES.agreement);
  });
});
