import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const dir = "test/demo/browser";

function finish(message, code = 0) {
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

if (!existsSync(dir)) {
  finish("demo browser acceptance: skipped, test/demo/browser is not in this revision");
}

const tests = readdirSync(dir).filter((name) => name.endsWith(".test.ts"));
if (tests.length === 0) {
  finish("demo browser acceptance: skipped, test/demo/browser is not in this revision");
}

const config = existsSync("vitest.browser.config.ts") ? "vitest.browser.config.ts" : "vitest.config.ts";
const result = spawnSync(
  process.execPath,
  ["./node_modules/vitest/vitest.mjs", "run", "--config", config, dir],
  { stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
