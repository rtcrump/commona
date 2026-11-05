import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The 19 M1 tests live in tests/acceptance and run under `npm run m1`.
    // They stay out of this job so a module that is not built yet does not fail CI.
    include: ["test/**/*.test.ts"],
    exclude: ["tests/acceptance/**", "test/worker/**", "node_modules/**", "dist/**"],
  },
});
