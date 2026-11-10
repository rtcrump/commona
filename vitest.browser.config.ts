import { defineConfig } from "vitest/config";

// Demo browser acceptance only. The Node suite in vitest.config.ts excludes
// this directory, so this config is what actually runs those tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/demo/browser/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
