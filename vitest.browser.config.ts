import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/demo/browser.acceptance.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
