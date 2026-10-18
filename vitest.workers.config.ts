import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          COMMONA_HOST_SECRET: "host-test-secret",
          COMMONA_PUBLIC_ORIGIN: "https://join.example.test",
        },
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    exclude: ["tests/acceptance/**", "node_modules/**", "dist/**"],
  },
});
