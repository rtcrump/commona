import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("compiled join pages", () => {
  it("reads the templates copied next to the build", async () => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
    execFileSync("node", ["scripts/copy-onboarding-pages.mjs"], { cwd: root, stdio: "inherit" });
    const href = pathToFileURL(join(root, "dist/src/onboarding/html.js")).href;
    const pages = (await import(href)) as {
      joinStylesheet: () => string;
      renderConnect: () => string;
    };
    expect(pages.joinStylesheet()).toContain("--ink");
    expect(pages.renderConnect()).toContain("Connect your assistant");
  }, 120_000);
});
